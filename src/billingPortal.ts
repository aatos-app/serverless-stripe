import { Stripe } from "stripe";


export const getAllPortalsFromStripe = async (stripe: Stripe): Promise<Stripe.BillingPortal.Configuration[]> => {
  const getAllPortalConfigurations = async (
    starting_after?: string,
    configurations: Stripe.BillingPortal.Configuration[] = []
  ): Promise<Stripe.BillingPortal.Configuration[]> => {
    const portalResponse = await stripe.billingPortal.configurations.list({
      limit: 100, // adjust this number based on how many records you want to fetch per request
      starting_after,
    });

    const allConfigurations = [...configurations, ...portalResponse.data];

    if (portalResponse.has_more) {
      const lastConfiguration =
      portalResponse.data[portalResponse.data.length - 1];
      // Recursively fetch more products
      return await getAllPortalConfigurations(lastConfiguration.id, allConfigurations);
    }

    return allConfigurations;
  };

  const portalConfigurations = await getAllPortalConfigurations();
  return portalConfigurations;
}