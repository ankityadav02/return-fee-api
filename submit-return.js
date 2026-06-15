import crypto from 'crypto';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://online-store-j97pgrml.myshopify.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature,
    shopify_order_id,
    return_reason,
    return_note
  } = req.body;

  // Step 1: Verify Razorpay payment signature
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
    return res.status(400).json({ error: 'Signature verification error' });
  }

  // Step 2: Get order line items from Shopify
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

    // Step 3: Submit return request via Shopify GraphQL API
    const lineItems = order.line_items.map(item => ({
      fulfillmentLineItemId: `gid://shopify/FulfillmentLineItem/${item.id}`,
      quantity: item.quantity,
      returnReason: mapReason(return_reason),
      customerNote: return_note || ''
    }));

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
                return {
                  id
                  status
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `,
          variables: {
            input: {
              orderId: `gid://shopify/Order/${shopify_order_id}`,
              returnLineItems: lineItems,
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
      message: 'Return request submitted successfully!',
      returnId: graphqlData?.data?.returnCreate?.return?.id
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

function mapReason(reason) {
  const map = {
    wrong_size: 'SIZE_TOO_SMALL',
    defective: 'DEFECTIVE',
    not_as_described: 'NOT_AS_DESCRIBED',
    changed_mind: 'UNWANTED',
    wrong_item: 'WRONG_ITEM',
  };
  return map[reason] || 'OTHER';
}
