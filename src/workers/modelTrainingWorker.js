import 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
import { workerEvents } from '../events/constants.js';

let _globalCtx = {};
let _model = null;

const WEIGHTS = {
    category: 0.30,
    body: 0.70 // Forte ênfase nas características de fit e biometria!
};

const normalize = (value, min, max) => Math.max(0, Math.min(1, (value - min) / ((max - min) || 1)));

// Transforma medidas imperfeitas como "5ft 2in" ou "160 cm" para um número contínuo (polegadas e depois normaliza)
function parseHeight(h) {
    if (!h) return null;
    if (typeof h === 'number') return h;
    const match = String(h).match(/([0-9]+)ft\s*(?:([0-9]+)in)?/);
    if (match) return parseInt(match[1]) * 12 + parseInt(match[2] || 0);
    const cmMatch = String(h).match(/([0-9]+)\s*cm/);
    if (cmMatch) return parseInt(cmMatch[1]) / 2.54;
    return Number(h) || null;
}

const parseNum = (v) => v !== null && v !== undefined && !isNaN(Number(v)) ? Number(v) : null;

// Essas são as métricas principais do users_grouped que indicam o fit da roupa.
const BODY_METRICS = ['height', 'waist', 'hips', 'bra', 'age'];
const TRAINING_EPOCHS = 25;
const TRAINING_BATCH_SIZE = 16;
const TRAINING_BODY_START = 10;
const TRAINING_BODY_END = 95;
const TRAINING_PREP_PRODUCTS_START = 10;
const TRAINING_PREP_PRODUCTS_END = 30;
const TRAINING_PREP_DATA_START = 30;
const TRAINING_PREP_DATA_END = 70;
const TRAINING_MAX_USERS = 1000;
const TRAINING_MAX_PRODUCTS = 1000;

function makeContext(products, users) {
    const categories = [...new Set(products.map(p => p.category || 'unknown'))];
    
    // Evita crash tf.oneHot caso o dataset subamostrado tenha só 1 categoria testada.
    if (categories.length < 2) categories.push('unknown_2');
    const categoriesIndex = Object.fromEntries(categories.map((c, i) => [c, i]));

    // Padroniza as métricas lidas
    users.forEach(u => {
        u._m = {
            height: parseHeight(u.height),
            waist: parseNum(u.waist),
            hips: parseNum(u.hips),
            bra: parseNum(u.bra_size),
            age: parseNum(u.age)
        };
    });

    // Encontra mínimo, máximo e médias de toda a população da loja
    const bounds = {};
    BODY_METRICS.forEach(m => {
        const vals = users.map(u => u._m[m]).filter(v => v !== null);
        const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
        bounds[m] = {
            min: vals.length ? Math.min(...vals) : 0,
            max: vals.length ? Math.max(...vals) : 1,
            avg
        };
        // Margem de segurança de dimensão de treino
        if (bounds[m].min === bounds[m].max) bounds[m].max += 1;
    });

    // Qual é a média dos corpos de quem compra um dado produto?
    const prodStats = {};
    users.forEach(user => {
        (user.purchases || []).forEach(p => {
            if (!prodStats[p.name]) {
                prodStats[p.name] = { counts: 0, height: 0, waist: 0, hips: 0, bra: 0, age: 0 };
            }
            prodStats[p.name].counts++;
            BODY_METRICS.forEach(m => {
                prodStats[p.name][m] += (user._m[m] !== null ? user._m[m] : bounds[m].avg);
            });
        });
    });

    // Normaliza essas médias p/ criar um vetor-assinatura para o produto refletindo a demografia de quem o compra.
    const productAveragesNorm = {};
    Object.keys(prodStats).forEach(p => {
        productAveragesNorm[p] = {};
        BODY_METRICS.forEach(m => {
            const avgVal = prodStats[p][m] / prodStats[p].counts;
            productAveragesNorm[p][m] = normalize(avgVal, bounds[m].min, bounds[m].max);
        });
    });

    return {
        products,
        users,
        categoriesIndex,
        productAveragesNorm,
        bounds,
        numCategories: categories.length,
        dimentions: BODY_METRICS.length + categories.length
    };
}

const oneHotWeighted = (index, length, weight) => tf.oneHot(index, length).cast('float32').mul(weight);

function encodeProduct(product, context) {
    // Extraímos como FEATURES do produto o Biotipo Médio Normalizado de seus compradores
    const prodMetrics = BODY_METRICS.map(m => {
        const val = context.productAveragesNorm[product.name] ? context.productAveragesNorm[product.name][m] : 0.5;
        return val * WEIGHTS.body; 
    });
    const bodyFeats = tf.tensor1d(prodMetrics);

    const category = oneHotWeighted(context.categoriesIndex[product.category] ?? 0, context.numCategories, WEIGHTS.category);

    return tf.concat1d([bodyFeats, category]);
}

function encodeUser(user, context) {
    // Vetorizamos o usuário como sendo uma média do que ele compra
    if (user.purchases && user.purchases.length) {
        return tf.stack(user.purchases.map(p => encodeProduct(p, context)))
                 .mean(0)
                 .reshape([1, context.dimentions]);
    }

    // Se é um usuário novo, a codificação cai sobre os traços reais da pessoa
    const m = {
        height: parseHeight(user.height),
        waist: parseNum(user.waist),
        hips: parseNum(user.hips),
        bra: parseNum(user.bra_size),
        age: parseNum(user.age)
    };

    const userMetrics = BODY_METRICS.map(key => {
        const val = m[key] !== null ? m[key] : context.bounds[key].avg;
        return normalize(val, context.bounds[key].min, context.bounds[key].max) * WEIGHTS.body;
    });

    return tf.concat1d([
        tf.tensor1d(userMetrics),
        tf.zeros([context.numCategories])
    ]).reshape([1, context.dimentions]);
}

function createTrainingData(context, onProgress = () => {}) {
    const inputs = [];
    const labels = [];
    
    const validUsers = context.users.filter(u => u.purchases && u.purchases.length).slice(0, TRAINING_MAX_USERS);
    const totalUsers = Math.max(1, validUsers.length);

    const precomputedProducts = context.products.map(product => {
        const tensor = encodeProduct(product, context);
        const arr = Array.from(tensor.dataSync());
        tensor.dispose();
        return { name: product.name, vector: arr };
    });

    validUsers.forEach((user, userIndex) => {
        const userT = encodeUser(user, context);
        const userVector = Array.from(userT.dataSync());
        userT.dispose();
        
        const posProds = [];
        const negProds = [];

        precomputedProducts.forEach(prodObj => {
            const isPurchase = user.purchases.some(purchase => purchase.name === prodObj.name);
            if (isPurchase) posProds.push(prodObj);
            else negProds.push(prodObj);
        });

        // 1. Inserir compras reais (Labels = 1)
        posProds.forEach(prodObj => {
            inputs.push([...userVector, ...prodObj.vector]);
            labels.push(1);
        });

        // 2. Balanceamento de Dados (Oversampling de negativos controlado)
        // Pra cada 1 compra real, ensinamos 2 itens que não foram comprados (Ratio 1:2)
        // Isso impede o modelo de ficar preguiçoso e dar 0% pra tudo.
        const numNegatives = Math.max(posProds.length * 2, 2);
        const sampledNegs = negProds.sort(() => 0.5 - Math.random()).slice(0, numNegatives);

        sampledNegs.forEach(prodObj => {
            inputs.push([...userVector, ...prodObj.vector]);
            labels.push(0);
        });

        if ((userIndex + 1) % 5 === 0 || userIndex === totalUsers - 1) {
            const percent = TRAINING_PREP_DATA_START + Math.round(((userIndex + 1) / totalUsers) * (TRAINING_PREP_DATA_END - TRAINING_PREP_DATA_START));
            onProgress(percent);
        }
    });

    return {
        xs: tf.tensor2d(inputs),
        ys: tf.tensor2d(labels, [labels.length, 1]),
        inputDimention: context.dimentions * 2
    };
}

async function configureNeuralNetAndTrain(trainData) {
    const model = tf.sequential();
    const stepsPerEpoch = Math.max(1, Math.ceil(trainData.xs.shape[0] / TRAINING_BATCH_SIZE));
    let currentEpoch = 0;
    
    model.add(tf.layers.dense({ inputShape: [trainData.inputDimention], units: 128, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 64, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));

    model.compile({
        optimizer: tf.train.adam(0.01),
        loss: 'binaryCrossentropy',
        metrics: ['accuracy']
    });

    await model.fit(trainData.xs, trainData.ys, {
        epochs: TRAINING_EPOCHS,
        batchSize: TRAINING_BATCH_SIZE,
        shuffle: true,
        callbacks: {
            onEpochBegin: (epoch) => {
                currentEpoch = epoch;
            },
            onBatchEnd: (batch) => {
                const totalSteps = TRAINING_EPOCHS * stepsPerEpoch;
                const currentStep = (currentEpoch * stepsPerEpoch) + (batch + 1);
                const percent = Math.min(
                    TRAINING_BODY_END,
                    TRAINING_BODY_START + Math.round((currentStep / totalSteps) * (TRAINING_BODY_END - TRAINING_BODY_START))
                );

                postMessage({
                    type: workerEvents.progressUpdate,
                    progress: percent,
                    stage: 'training'
                });
            },
            onEpochEnd: (epoch, logs) => {
                const percent = Math.round(((epoch + 1) / TRAINING_EPOCHS) * 100);
                postMessage({
                    type: workerEvents.trainingLog,
                    epoch: epoch,
                    totalEpochs: TRAINING_EPOCHS,
                    progress: percent,
                    loss: logs.loss,
                    accuracy: logs.acc || logs.accuracy
                });
            }
        }
    });

    return model;
}

async function trainModel({ users } = {}) {
    console.log('Training model; users param provided?:', !!users);
    postMessage({ type: workerEvents.progressUpdate, progress: 1, stage: 'loading' });

    if (!users) {
        const candidates = [
            '/out/users_grouped.json',
            '/users_grouped.json',
            '/data/users_grouped.json'
        ];

        let loaded = null;
        for (const p of candidates) {
            try {
                const res = await fetch(p);
                if (!res.ok) continue;
                const json = await res.json();
                if (Array.isArray(json)) { loaded = json; break; }
                if (json && Array.isArray(json.users)) { loaded = json.users; break; }
            } catch (e) {}
        }

        if (!loaded) {
            console.error('No users provided and users_grouped.json not found');
            return;
        }

        users = loaded.map(u => {
            const productsArr = Array.isArray(u.products) ? u.products : (u.items || u.purchases || []);
            const purchases = productsArr.map(p => ({
                id: p.item_id || p.id || null,
                name: p.item_id || p.name || p.id || p.title || 'unknown',
                category: p.category || p.quality || 'unknown'
            }));
            return Object.assign({}, u, { purchases });
        });
    }

    const productsRes = await fetch('/data/products.json');
    let products = await productsRes.json();
    products = products.slice(0, TRAINING_MAX_PRODUCTS);
    
    // Garante que o catálogo completo entre no treino e preserva itens consumidos que não estejam no catálogo
    const prodMap = new Map(products.map(product => [product.name, Object.assign({}, product)]));
    users.forEach(u => u.purchases.forEach(p => {
        if (!prodMap.has(p.name)) {
            prodMap.set(p.name, Object.assign({}, p));
        }
    }));
    products = Array.from(prodMap.values());

    const context = makeContext(products, users);
    postMessage({ type: workerEvents.progressUpdate, progress: TRAINING_BODY_START, stage: 'preparing-data' });
    const totalProducts = Math.max(1, products.length);
    context.productVectors = products.map((product, index) => {
        if ((index + 1) % 10 === 0 || index === totalProducts - 1) {
            const percent = TRAINING_PREP_PRODUCTS_START + Math.round(((index + 1) / totalProducts) * (TRAINING_PREP_PRODUCTS_END - TRAINING_PREP_PRODUCTS_START));
            postMessage({ type: workerEvents.progressUpdate, progress: percent, stage: 'preparing-data' });
        }
        return {
            name: product.name,
            meta: { ...product },
            vector: encodeProduct(product, context).dataSync()
        };
    });

    _globalCtx = context;

    const trainData = createTrainingData(context, (percent) => {
        postMessage({ type: workerEvents.progressUpdate, progress: percent, stage: 'preparing-data' });
    });
    postMessage({ type: workerEvents.progressUpdate, progress: TRAINING_BODY_START, stage: 'fitting-model' });
    _model = await configureNeuralNetAndTrain(trainData);

    // Cleanup tfjs memory
    trainData.xs.dispose();
    trainData.ys.dispose();

    postMessage({ type: workerEvents.progressUpdate, progress: 100, stage: 'complete' });
    postMessage({ type: workerEvents.trainingComplete });
}

function recommend({ user }) {
    console.log("Worker rx recommend event", user);
    try {
    if (!_model) return;
    const context = _globalCtx;

    const userVector = encodeUser(user, context).dataSync();

    const inputs = context.productVectors.map(({ vector }) => {
        return [...userVector, ...vector];
    });

    const inputTensor = tf.tensor2d(inputs);
    const predictions = _model.predict(inputTensor);
    const scores = predictions.dataSync();

    const recommendations = context.productVectors.map((item, index) => {
        return {
            ...item.meta,
            name: item.name,
            score: scores[index]
        };
    });

    const sortedItems = recommendations.sort((a, b) => b.score - a.score).slice(0, 30);
    inputTensor.dispose();
    predictions.dispose();

    postMessage({
        type: workerEvents.recommend,
        user,
        recommendations: sortedItems
    });
    } catch(err) {
        console.error("Error in recommend:", err);
    }
}

const handlers = {
    [workerEvents.trainModel]: trainModel,
    [workerEvents.recommend]: recommend,
};

self.onmessage = e => {
    const { action, ...data } = e.data;
    if (handlers[action]) handlers[action](data);
};
