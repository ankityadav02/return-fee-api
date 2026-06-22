import express from 'express';
import crypto from 'crypto';
import Razorpay from 'razorpay';

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
  try {
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_SECRET
    });

    const order = await razorpay.orders.create({
      amount: 10000,
      currency: 'INR',
      receipt: `return_${req.body.shopify_order_id}_${Date.now()}`
    });

    return res.status(200).json({ orderId: order.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Verify Payment + Submit Shopify Return
app.post('/api/submit-return', async (req, res) => {
  const {
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature,
    shopify_order_id,
    return_reason,
    return_note
  } = req.body;

  // Verify Razorpay signature
  try {
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }
  } catch (err) {
    return res.status(400).json({ error: 'Signature error' });
  }

  // Get Shopify order
  try {
    const orderRes = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/orders/${shopify_order_id}.json`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    const orderData = await orderRes.json();
    const order = orderData.order;
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Submit return via GraphQL
    const fulfillmentId = order.fulfillments?.[0]?.line_items?.[0]?.id;
    
    const graphqlRes = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: `
            mutation returnCreate($input: ReturnInput!) {
              returnCreate(input: $input) {
                return { id status }
                userErrors { field message }
              }
            }
          `,
          variables: {
            input: {
              orderId: `gid://shopify/Order/${shopify_order_id}`,
              returnLineItems: order.fulfillments[0].line_items.map(item => ({
                fulfillmentLineItemId: `gid://shopify/FulfillmentLineItem/${item.id}`,
                quantity: item.quantity,
                returnReason: mapReason(return_reason),
                customerNote: return_note || ''
              })),
              notifyCustomer: true
            }
          }
        })
      }
    );

    const graphqlData = await graphqlRes.json();
    const errors = graphqlData?.data?.returnCreate?.userErrors;

    if (errors && errors.length > 0) {
      return res.status(400).json({ error: errors[0].message });
    }

    return res.status(200).json({
      success: true,
      message: 'Return submitted!',
      returnId: graphqlData?.data?.returnCreate?.return?.id
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

function mapReason(reason) {
  const map = {
    wrong_size: 'SIZE_TOO_SMALL',
    defective: 'DEFECTIVE',
    not_as_described: 'NOT_AS_DESCRIBED',
    changed_mind: 'UNWANTED',
    wrong_item: 'WRONG_ITEM'
  };
  return map[reason] || 'OTHER';
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
