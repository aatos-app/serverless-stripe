import { Stripe } from "stripe";


export const getAllProductsFromStripe = async (stripe: Stripe): Promise<Stripe.Product[]> => {
  const getAllProducts = async (
    starting_after?: string,
    products: Stripe.Product[] = []
  ): Promise<Stripe.Product[]> => {
    const productResponse = await stripe.products.list({
      limit: 100, // adjust this number based on how many records you want to fetch per request
      starting_after,
    });

    const allProducts = [...products, ...productResponse.data];

    if (productResponse.has_more) {
      // Get the last product in the list
      const lastProduct =
        productResponse.data[productResponse.data.length - 1];
      // Recursively fetch more products
      return await getAllProducts(lastProduct.id, allProducts);
    }

    return allProducts;
  };

  const products = await getAllProducts();
  return products;
}