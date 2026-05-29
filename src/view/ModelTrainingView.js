import { View } from './View.js';

export class ModelView extends View {
    #trainModelBtn = document.querySelector('#trainModelBtn');
    #purchasesArrow = document.querySelector('#purchasesArrow');
    #purchasesDiv = document.querySelector('#purchasesDiv');
    #allUsersPurchasesList = document.querySelector('#allUsersPurchasesList');
    #runRecommendationBtn = document.querySelector('#runRecommendationBtn');
    #onTrainModel;
    #onRunRecommendation;

    constructor() {
        super();
        this.attachEventListeners();
    }

    registerTrainModelCallback(callback) {
        this.#onTrainModel = callback;
    }
    registerRunRecommendationCallback(callback) {
        this.#onRunRecommendation = callback;
    }

    attachEventListeners() {
        this.#trainModelBtn.addEventListener('click', () => {
            if (this.#onTrainModel) {
                this.#onTrainModel();
            }
        });
        this.#runRecommendationBtn.addEventListener('click', () => {
            if (this.#onRunRecommendation) {
                this.#onRunRecommendation();
            }
        });

        this.#purchasesDiv.addEventListener('click', () => {
            const purchasesList = this.#allUsersPurchasesList;

            const isHidden = window.getComputedStyle(purchasesList).display === 'none';

            if (isHidden) {
                purchasesList.style.display = 'block';
                this.#purchasesArrow.classList.remove('bi-chevron-down');
                this.#purchasesArrow.classList.add('bi-chevron-up');
            } else {
                purchasesList.style.display = 'none';
                this.#purchasesArrow.classList.remove('bi-chevron-up');
                this.#purchasesArrow.classList.add('bi-chevron-down');
            }
        });

    }
    enableRecommendButton() {
        this.#runRecommendationBtn.disabled = false;
    }
    
    updateEpochProgress(logs) {
        if (!this.#trainModelBtn.disabled) return;
        const totalEpochs = logs.totalEpochs || 15;
        const progress = logs.progress || Math.round(((logs.epoch + 1) / totalEpochs) * 100);
        this.#trainModelBtn.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Training ${progress}% (Epoch ${logs.epoch + 1}/${totalEpochs})...`;
    }

    updateTrainingProgress(progress) {
        this.#trainModelBtn.disabled = true;
        const percent = typeof progress === 'number' ? progress : (progress?.progress ?? 0);
        const stage = typeof progress === 'object' && progress?.stage ? progress.stage : 'training';
        const stageLabel = {
            loading: 'Loading data',
            'preparing-data': 'Preparing data',
            'fitting-model': 'Training',
            training: 'Training',
            complete: 'Finalizing'
        }[stage] || 'Training';

        this.#trainModelBtn.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> ${stageLabel} ${percent}%`;

        if (percent === 100) {
            this.#trainModelBtn.disabled = false;
            this.#trainModelBtn.innerHTML = '<i class="bi bi-cpu"></i> Train Model';
        }
    }

    renderAllUsersPurchases(users) {
        const html = users.map(user => {
            const purchasesHtml = user.purchases.map(purchase => {
                return `<span class="badge bg-light text-dark me-1 mb-1 border border-secondary">
                    Item #${purchase.name} <br/> 
                    <small>Size: ${purchase.size || '?'} | Quality: ${purchase.quality || '?'}</small>
                </span>`;
            }).join('');

            return `
                <div class="user-purchase-summary mb-3 border-bottom pb-2">
                    <h6>${user.name} (Height: ${user.height || '?'})</h6>
                    <div class="purchases-badges">
                        ${purchasesHtml || '<span class="text-muted">No purchases</span>'}
                    </div>
                </div>
            `;
        }).join('');

        this.#allUsersPurchasesList.innerHTML = html;
    }
}
