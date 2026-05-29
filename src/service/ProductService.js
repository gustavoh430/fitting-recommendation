export class ProductService {
    async getProducts() {
        const response = await fetch('./data/products.json');
        return await response.json();
    }

    async getProductById(id) {
        const products = await this.getProducts();
        return products.find(product => String(product.id) === String(id));
    }

    async getProductsByIds(ids) {
        const products = await this.getProducts();
        const strIds = ids.map(id => String(id));
        return products.filter(product => strIds.includes(String(product.id)));
    }
}
