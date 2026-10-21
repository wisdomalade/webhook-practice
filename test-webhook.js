
const crypto = require("crypto");

const secret = "my_practice_webhook_secret";

const payload = JSON.stringify({
    type: "payment.success",
    data: {
        paymentId: "PAY12345",
        amount: 5000,
        currency: "NGN"
    }
});

const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

async function sendWebhook() {
    const response = await fetch(
        "http://localhost:5000/webhooks/payment",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-webhook-signature": signature
            },
            body: payload
        }
    );

    console.log("Status:", response.status);
    console.log("Response:", await response.json());
}

sendWebhook().catch(console.error);
