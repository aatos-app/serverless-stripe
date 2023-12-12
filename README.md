# Serverless Stripe Plugin

This plugin is designed for the Serverless Framework. It automates the creation of Stripe webhooks and binds them to serverless functions. It also provides some basic functionality for creating products and prices to them (the focus is is to help create subscriptions that utilize those).

**Steps for using this plugin:**

1. Install and configure the `serverless-domain-manager` plugin.

2. Generate a Stripe API key. You'll need permissions for managing webhooks, products and prices. Also make sure you have aws rights to put and read aws ssm parameters

3. Modify your serverless configuration as shown below:
    ```markdown
      custom: {
        stripe: {
          apiKey: 'my-stripe-api-key',
          webhooks: [
            {
              functionName: 'webhookHandler',
              events: [
                'invoice.payment_succeeded',
              ],
              webhookSecretEnvVariableName: 'stripeWebhookSecret',
            },
          ],
          products: [
            {
              name: 'Subscription',
              internal: {
                id: 'subscription',
                description: 'Subscription product',
              },
              prices: [
                {
                  id: 'price_sweden',
                  price: 9900,
                  currency: 'sek',
                  interval: 'year',
                  countryCode: 'SE',
                },
              ],
            },
          ],
        },
        domain: {
          // Please note these are serverless-domain-manager configurations but they're also used in this plugin
          domainName: "mydomain.com",
          basePath: "my-api",
        },
      },
    ```

4. Develop the `webhookHandler` function. The Stripe webhook endpoint secret will be available as `process.env.stripeWebhookSecret` (or under whatever name you've configured in `webhookSecretEnvVariableName`).

5. If you add any products, the generated Stripe product id will be accessible through environment variables, using the internal id (e.g., `process.env["subscription"]` in this example). The same applies to product prices (e.g., `process.env["price_sweden"]` for this case).

6. Deploy your Serverless application.

You can refer to the source code provided if you're interested in the underlying implementation of this plugin.