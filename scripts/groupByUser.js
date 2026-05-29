const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Try to load normalizeReview if available
let normalizeReview = null;
try {
  const norm = require('../src/etl/normalize');
  normalizeReview = norm && norm.normalizeReview ? norm.normalizeReview : null;
} catch (e) {
  normalizeReview = null;
}

function ensureDir(filePath) {
  const d = path.dirname(filePath);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

async function readObjectsFromFile(filePath) {
  const stat = fs.statSync(filePath);
  // try parsing as JSON array if small enough
  if (stat.size < 50 * 1024 * 1024) { // 50MB
    try {
      const txt = fs.readFileSync(filePath, 'utf8').trim();
      if (!txt) return [];
      if (txt.startsWith('[')) return JSON.parse(txt);
    } catch (e) {
      // fall back to NDJSON streaming
    }
  }

  const inStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: inStream, crlfDelay: Infinity });
  const out = [];
  for await (const line of rl) {
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch (err) {
      // ignore parse errors
    }
  }
  return out;
}

function pickUserFeatures(obj) {
  // normalize incoming keys and pick known user-related fields
  const normalized = {};
  for (const k of Object.keys(obj)) {
    const nk = k.toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    normalized[nk] = obj[k];
  }

  const keys = ['user_id','user_name','waist','cup_size','cup_size','cup_size','hips','bra_size','bra_size','bra_size','bust','bust_size','height','height_cm','shoe_size','shoe_width','weight','age','body_type'];
  const u = {};
  for (const k of keys) if (normalized[k] !== undefined) u[k] = normalized[k];
  return u;
}

function pickProductFeatures(obj) {
  const normalized = {};
  for (const k of Object.keys(obj)) {
    const nk = k.toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    normalized[nk] = obj[k];
  }
  const keys = ['item_id','size','quality','category'];
  const p = {};
  for (const k of keys) if (normalized[k] !== undefined) p[k] = normalized[k];
  // also accept 'itemid' or 'item' variants
  if (!p.item_id && (normalized.itemid || normalized.item)) p.item_id = normalized.itemid || normalized.item;
  return p;
}

function pickProductFeedback(obj) {
  const normalized = {};
  for (const k of Object.keys(obj)) {
    const nk = k.toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    normalized[nk] = obj[k];
  }
  const keys = ['length','fit','rating','review_date','rented_for'];
  const f = {};
  for (const k of keys) if (normalized[k] !== undefined) f[k] = normalized[k];
  // accept 'reviewdate' or 'review date'
  if (!f.review_date && (normalized.reviewdate)) f.review_date = normalized.reviewdate;
  // accept 'rented for' variant
  if (!f.rented_for && normalized['rented_for']) f.rented_for = normalized['rented_for'];
  return f;
}

// --- Fit-only specific pickers (match raw_data_fit structure) ---
function pickUserFeaturesFit(obj) {
  const normalized = {};
  for (const k of Object.keys(obj)) {
    const nk = k.toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    normalized[nk] = obj[k];
  }
  const keys = ['user_id','user_name','waist','cup_size','hips','bra_size','bust','height','shoe_size','shoe_width'];
  const u = {};
  for (const k of keys) u[k] = (normalized[k] !== undefined ? normalized[k] : null);
  return u;
}

function pickProductFeaturesFit(obj) {
  const normalized = {};
  for (const k of Object.keys(obj)) {
    const nk = k.toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    normalized[nk] = obj[k];
  }
  const keys = ['item_id','size','quality','category'];
  const p = {};
  for (const k of keys) p[k] = (normalized[k] !== undefined ? normalized[k] : null);
  return p;
}

function pickProductFeedbackFit(obj) {
  const normalized = {};
  for (const k of Object.keys(obj)) {
    const nk = k.toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    normalized[nk] = obj[k];
  }
  const keys = ['length','fit'];
  const f = {};
  for (const k of keys) f[k] = (normalized[k] !== undefined ? normalized[k] : null);
  return f;
}

async function groupByUser(inputPath, outGroupedPath, outFlatPath, options = {}) {
  // inputPath may be a string or an array of file paths
  const inputPaths = Array.isArray(inputPath) ? inputPath : [inputPath];
  const absInputs = inputPaths.map(p => path.resolve(p));
  const absGrouped = path.resolve(outGroupedPath);
  const absFlat = path.resolve(outFlatPath);

  for (const p of absInputs) if (!fs.existsSync(p)) {
    // skip missing inputs but warn
    console.warn('warning: input not found (skipping):', p);
  }
  ensureDir(absGrouped);
  ensureDir(absFlat);

  console.log('Reading inputs ->', absInputs.join(', '));
  // read and concatenate all objects
  let objs = [];
  for (const p of absInputs) {
    if (!fs.existsSync(p)) continue;
    const part = await readObjectsFromFile(p);
    objs = objs.concat(part);
  }
  console.log('Read', objs.length, 'objects');

  const flat = [];
  const groups = new Map();
  // map to dedupe/merge transactions by user+item
  const txMap = new Map();

  for (const raw of objs) {
    const r = (options.normalize && normalizeReview) ? normalizeReview(raw) : raw;

    const user_id = r.user_id || r.userId || r.user || 'unknown';
    const user_name = r.user_name || r.username || r.userName || r.name || null;

    // choose pickers (fit-only mode uses specialized pickers)
    const userSnapshot = options.fitOnly ? pickUserFeaturesFit(r) : pickUserFeatures(r);

    // assemble product entry for this transaction
    const productEntry = Object.assign(
      {},
      options.fitOnly ? pickProductFeaturesFit(r) : pickProductFeatures(r),
      options.fitOnly ? pickProductFeedbackFit(r) : pickProductFeedback(r),
      {
        review_text: r.review_text || r.reviewText || null,
        review_summary: r.review_summary || r.reviewSummary || null
      }
    );

    // keep original flat record for downstream use
    flat.push(Object.assign({}, r));

    // initialize or update user group
    if (!groups.has(user_id)) {
      // ensure requested user characteristic fields exist (explicit keys)
      const userKeys = ['waist','cup_size','bra_size','bust','bust_size','shoe_size','shoe_width','hips','height','height_cm','weight','age','body_type','user_name','user_id'];
      const base = { user_id, user_name: user_name || null };
      for (const k of userKeys) {
        if (base[k] === undefined) base[k] = (userSnapshot[k] !== undefined ? userSnapshot[k] : null);
      }
      const userObj = Object.assign(base, userSnapshot, { products: [] });
      groups.set(user_id, userObj);
    } else {
      // merge missing user fields (prefer existing values)
      const existing = groups.get(user_id);
      for (const k of Object.keys(userSnapshot)) {
        if ((existing[k] === undefined || existing[k] === null) && (userSnapshot[k] !== undefined && userSnapshot[k] !== null)) {
          existing[k] = userSnapshot[k];
        }
      }
    }

    // merge by transaction key (user_id + item_id) to combine complementary files
    const txKey = `${user_id}||${productEntry.item_id || 'unknown'}`;
    if (!txMap.has(txKey)) {
      txMap.set(txKey, productEntry);
      groups.get(user_id).products.push(productEntry);
    } else {
      // merge fields into existing product entry
      const existingProd = txMap.get(txKey);
      for (const k of Object.keys(productEntry)) {
        if ((existingProd[k] === undefined || existingProd[k] === null) && (productEntry[k] !== undefined && productEntry[k] !== null)) {
          existingProd[k] = productEntry[k];
        }
      }
    }
  }

  const groupedArr = Array.from(groups.values());
  fs.writeFileSync(absGrouped, JSON.stringify(groupedArr, null, 2), 'utf8');
  fs.writeFileSync(absFlat, JSON.stringify(flat, null, 2), 'utf8');

  console.log('Wrote grouped users:', groupedArr.length, '->', absGrouped);
  console.log('Wrote flat reviews:', flat.length, '->', absFlat);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const pos = argv.filter(a => !a.startsWith('--'));

  let inputs;
  if (pos.length === 0) {
    if (flags.has('--fit-only')) {
      const candidate = path.join(process.cwd(), 'src', 'dataRaw', 'raw_data_fit.json');
      inputs = fs.existsSync(candidate) ? [candidate] : [candidate];
    } else {
      const candidates = [
        path.join(process.cwd(), 'src', 'dataRaw', 'raw_data.json'),
        path.join(process.cwd(), 'src', 'dataRaw', 'raw_data_fit.json')
      ];
      inputs = candidates.filter(p => fs.existsSync(p));
      if (inputs.length === 0) inputs = [candidates[0]];
    }
  } else {
    const maybeList = pos[0];
    inputs = maybeList.includes(',') ? maybeList.split(',').map(s => s.trim()) : [maybeList];
  }

  const outGrouped = pos[1] || path.join(process.cwd(), 'out', (flags.has('--fit-only') ? 'users_grouped_fit.json' : 'users_grouped.json'));
  const outFlat = pos[2] || path.join(process.cwd(), 'out', (flags.has('--fit-only') ? 'reviews_flat_fit.json' : 'reviews_flat.json'));
  const normalizeFlag = flags.has('--normalize');
  const fitOnlyFlag = flags.has('--fit-only');

  groupByUser(inputs, outGrouped, outFlat, { normalize: normalizeFlag, fitOnly: fitOnlyFlag })
    .then(() => console.log('Done'))
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { groupByUser };
