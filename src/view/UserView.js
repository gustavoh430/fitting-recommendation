import { View } from './View.js';

export class UserView extends View {
    #userSelect = document.querySelector('#userSelect');
    #userAge = document.querySelector('#userAge');
    #pastPurchasesList = document.querySelector('#pastPurchasesList');

    #purchaseTemplate;
    #onUserSelect;
    #onPurchaseRemove;
    #pastPurchaseElements = [];

    constructor() {
        super();
        this.init();
    }

    async init() {
        this.#purchaseTemplate = await this.loadTemplate('./src/view/templates/past-purchase.html');
        this.attachUserSelectListener();
    }

    normalizePurchase(product) {
        return {
            ...product,
            size: product.size || 'Standard',
            quality: product.quality || 'Unknown'
        };
    }

    registerUserSelectCallback(callback) {
        this.#onUserSelect = callback;
    }

    registerPurchaseRemoveCallback(callback) {
        this.#onPurchaseRemove = callback;
    }

    renderUserOptions(users) {
        const options = users.map(user => {
            return `<option value="${user.id}">${user.name}</option>`;
        }).join('');

        this.#userSelect.innerHTML += options;
    }

    renderUserDetails(user) {
        const h = user.height ? `H:${user.height}` : '';
        const w = user.waist ? `W:${user.waist}` : '';
        const hi = user.hips ? `Hp:${user.hips}` : '';
        const b = user.bra_size ? `Bra:${user.bra_size}` : '';
        this.#userAge.value = [h, w, hi, b].filter(Boolean).join(' | ') || "No biometrics";
    }

    renderPastPurchases(pastPurchases) {
        if (!this.#purchaseTemplate) return;

        if (!pastPurchases || pastPurchases.length === 0) {
            this.#pastPurchasesList.innerHTML = '<p>No past purchases found.</p>';
            return;
        }

        const html = pastPurchases.map(product => {
            const purchase = this.normalizePurchase(product);
            return this.replaceTemplate(this.#purchaseTemplate, {
                ...purchase,
                product: JSON.stringify(purchase)
            });
        }).join('');

        this.#pastPurchasesList.innerHTML = html;
        this.attachPurchaseClickHandlers();
    }

    addPastPurchase(product) {

        if (this.#pastPurchasesList.innerHTML.includes('No past purchases found')) {
            this.#pastPurchasesList.innerHTML = '';
        }

        const purchase = this.normalizePurchase(product);

        const purchaseHtml = this.replaceTemplate(this.#purchaseTemplate, {
            ...purchase,
            product: JSON.stringify(purchase)
        });

        this.#pastPurchasesList.insertAdjacentHTML('afterbegin', purchaseHtml);

        const newPurchase = this.#pastPurchasesList.firstElementChild.querySelector('.past-purchase');
        newPurchase.classList.add('past-purchase-highlight');

        setTimeout(() => {
            newPurchase.classList.remove('past-purchase-highlight');
        }, 1000);

        this.attachPurchaseClickHandlers();
    }

    attachUserSelectListener() {
        this.#userSelect.addEventListener('change', (event) => {
            const userId = event.target.value ? event.target.value : null;

            if (userId) {
                if (this.#onUserSelect) {
                    this.#onUserSelect(userId);
                }
            } else {
                this.#userAge.value = '';
                this.#pastPurchasesList.innerHTML = '';
            }
        });
    }

    attachPurchaseClickHandlers() {
        this.#pastPurchaseElements = [];

        const purchaseElements = document.querySelectorAll('.past-purchase');

        purchaseElements.forEach(purchaseElement => {
            this.#pastPurchaseElements.push(purchaseElement);

            purchaseElement.onclick = (event) => {

                const product = JSON.parse(purchaseElement.dataset.product);
                const userId = this.getSelectedUserId();
                const element = purchaseElement.closest('.col-md-6');

                this.#onPurchaseRemove({ element, userId, product });

                element.style.transition = 'opacity 0.5s ease';
                element.style.opacity = '0';

                setTimeout(() => {
                    element.remove();

                    if (document.querySelectorAll('.past-purchase').length === 0) {
                        this.renderPastPurchases([]);
                    }

                }, 500);

            }
        });
    }

    getSelectedUserId() {
        return this.#userSelect.value ? this.#userSelect.value : null;
    }
}
