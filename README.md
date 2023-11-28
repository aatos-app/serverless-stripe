# Serverless Stripe Plugin
Plugin for Serverless Framework to automatically create Stripe webhooks and bind them to serverless functions

In short:
1. Install serverless-domain-manager plugin and configure it
2. Create a stripe api key (permissions needed for managing webhooks)
3. edit your serverless configuration
    ```
      custom: {
        stripe: {
          apiKey: 'my-stripe-api-key',
          webhooks: [
            {
              functionName: 'webhookHandler', // a function with this name needs to exist and has to handle POST requests
              events: [
                'invoice.payment_succeeded',
              ],
              webhookSecretEnvVariableName: 'stripeWebhookSecret',
            },
          ],
        },
        domain: { 
          // not these are serverless-domain-manager configs but are also used in this plugin
          domainName: "mydomain.com",
          basePath: "my-api",
        }
      },
    ```
4. Create the `webhookHandler` function, the stripe webhooke endpoint secret will be available under `process.env.stripeWebhookSecret` (or whichever you've configured in `webhookSecretEnvVariableName`)
5. Deploy
