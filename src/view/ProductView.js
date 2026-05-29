import { View } from './View.js';

export class ProductView extends View {
    // DOM elements
    #productList = document.querySelector('#productList');

    #buttons;
    // Templates and callbacks
    #productTemplate;
    #onBuyProduct;

    constructor() {
        super();
        this.init();
    }

    async init() {
        this.#productTemplate = await this.loadTemplate('./src/view/templates/product-card.html');
    }

    onUserSelected(user) {
        // Enable buttons if a user is selected, otherwise disable them
        this.setButtonsState(user.id ? false : true);
    }

    registerBuyProductCallback(callback) {
        this.#onBuyProduct = callback;
    }

    render(products, disableButtons = true) { console.log("ProductView rendering array sizes: ", products ? products.length : "null"); 
        if (!this.#productTemplate) return;
        const html = products.map(product => {
            const displayScore = product.score !== undefined ? `<strong>Match:</strong> ${(product.score * 100).toFixed(1)}%<br>` : '';
            return this.replaceTemplate(this.#productTemplate, {
                id: product.id,
                name: product.name,
                category: product.category,
                size: product.size || "Standard",
                quality: product.quality || "5",
                scoreHtml: displayScore,
                product: JSON.stringify(product)
            });
        }).join('');

        this.#productList.innerHTML = html;
        this.attachBuyButtonListeners();

        // Disable all buttons by default
        this.setButtonsState(disableButtons);
    }

    setButtonsState(disabled) {
        if (!this.#buttons) {
            this.#buttons = document.querySelectorAll('.buy-now-btn');
        }
        this.#buttons.forEach(button => {
            button.disabled = disabled;
        });
    }

    attachBuyButtonListeners() {
        this.#buttons = document.querySelectorAll('.buy-now-btn');
        this.#buttons.forEach(button => {

            button.addEventListener('click', (event) => {
                const product = JSON.parse(button.dataset.product);
                const originalText = button.innerHTML;

                button.innerHTML = '<i class="bi bi-check-circle-fill"></i> Added';
                button.classList.remove('btn-primary');
                button.classList.add('btn-success');
                setTimeout(() => {
                    button.innerHTML = originalText;
                    button.classList.remove('btn-success');
                    button.classList.add('btn-primary');
                }, 500);
                this.#onBuyProduct(product, button);

            });
        });
    }
}
