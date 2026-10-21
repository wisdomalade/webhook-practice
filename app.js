
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const WebhookEvent = require("./models/WebhookEvent");

const app = express();

const PORT = process.env.PORT || 5000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!process.env.MONGODB_URI || !WEBHOOK_SECRET) {
    console.error("Missing MONGODB_URI or WEBHOOK_SECRET in .env");
    process.exit(1);
}

app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Webhook server is running"
    });
});

app.post(
    "/webhooks/payment",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        try {
            // 1. Verify the signature.
            const signature = req.get("x-webhook-signature");

            if (!signature || !Buffer.isBuffer(req.body)) {
                return res.status(400).json({
                    success: false,
                    message: "Missing signature or invalid request body"
                });
            }

            if (!/^[a-fA-F0-9]{64}$/.test(signature)) {
                return res.status(401).json({
                    success: false,
                    message: "Invalid webhook signature"
                });
            }

            const expectedSignature = crypto
                .createHmac("sha256", WEBHOOK_SECRET)
                .update(req.body)
                .digest();

            const receivedSignature = Buffer.from(signature, "hex");

            if (
                receivedSignature.length !== expectedSignature.length ||
                !crypto.timingSafeEqual(
                    receivedSignature,
                    expectedSignature
                )
            ) {
                return res.status(401).json({
                    success: false,
                    message: "Invalid webhook signature"
                });
            }

            // 2. Parse the JSON body.
            let event;

            try {
                event = JSON.parse(req.body.toString("utf8"));
            } catch {
                return res.status(400).json({
                    success: false,
                    message: "Invalid JSON payload"
                });
            }

            // 3. Validate the event.
            if (
                !event ||
                typeof event !== "object" ||
                Array.isArray(event) ||
                typeof event.id !== "string" ||
                !event.id.trim() ||
                typeof event.type !== "string" ||
                !event.type.trim()
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid event ID or event type"
                });
            }

            if (event.type === "payment.success") {
                if (
                    !event.data ||
                    typeof event.data.paymentId !== "string" ||
                    !event.data.paymentId.trim()
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Missing or invalid payment ID"
                    });
                }
            }

            // 4. Create the event if it doesn't exist yet.
            try {
                await WebhookEvent.updateOne(
                    { eventId: event.id },
                    {
                        $setOnInsert: {
                            eventId: event.id,
                            eventType: event.type,
                            payload: event,
                            status: "received",
                            attempts: 0,
                            lastError: null,
                            processedAt: null
                        }
                    },
                    { upsert: true }
                );
            } catch (error) {
                // Another request may have inserted the same ID.
                if (error.code !== 11000) {
                    throw error;
                }
            }

            // 5. Atomically claim a new or failed event.
            const claimedEvent = await WebhookEvent.findOneAndUpdate(
                {
                    eventId: event.id,
                    status: { $in: ["received", "failed"] }
                },
                {
                    $set: {
                        status: "processing",
                        lastError: null
                    },
                    $inc: {
                        attempts: 1
                    }
                },
                {
                    new: true
                }
            );

            if (!claimedEvent) {
                const existingEvent = await WebhookEvent.findOne({
                    eventId: event.id
                });

                if (!existingEvent) {
                    return res.status(500).json({
                        success: false,
                        message: "Could not find webhook event"
                    });
                }

                if (existingEvent.status === "processed") {
                    return res.status(200).json({
                        success: true,
                        received: true,
                        duplicate: true,
                        status: "processed"
                    });
                }

                return res.status(409).json({
                    success: false,
                    received: true,
                    duplicate: true,
                    status: existingEvent.status,
                    message: "Event is already being processed"
                });
            }

            try {
                // 6. Simulate processing the payment event.
                // This is a practice handler, not a real payment operation.
                if (event.type === "payment.success") {
                    console.log("Processing payment event:", {
                        eventId: event.id,
                        paymentId: event.data.paymentId,
                        amount: event.data.amount,
                        currency: event.data.currency
                    });

                    // Testing feature: set simulateFailure to true
                    // in the JSON body to practise failure and retries.
                    if (event.data.simulateFailure === true) {
                        throw new Error("Simulated payment processing failure");
                    }
                } else {
                    console.log("Received unsupported event:", event.type);
                }

                // 7. Mark the event as processed after the handler succeeds.
                const completedEvent = await WebhookEvent.findOneAndUpdate(
                    {
                        eventId: event.id,
                        status: "processing"
                    },
                    {
                        $set: {
                            status: "processed",
                            processedAt: new Date(),
                            lastError: null
                        }
                    },
                    {
                        new: true
                    }
                );

                if (!completedEvent) {
                    throw new Error("Could not mark event as processed");
                }

                return res.status(200).json({
                    success: true,
                    received: true,
                    duplicate: false,
                    status: "processed",
                    attempts: completedEvent.attempts,
                    eventId: event.id
                });
            } catch (processingError) {
                console.error(
                    "Event processing failed:",
                    processingError.message
                );

                await WebhookEvent.updateOne(
                    {
                        eventId: event.id,
                        status: "processing"
                    },
                    {
                        $set: {
                            status: "failed",
                            lastError: processingError.message
                        }
                    }
                );

                return res.status(500).json({
                    success: false,
                    received: true,
                    status: "failed",
                    message: "Event processing failed; retry is possible",
                    eventId: event.id
                });
            }
        } catch (error) {
            console.error("Webhook error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Internal server error"
            });
        }
    }
);

async function startServer() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("MongoDB Atlas connected successfully");

        await WebhookEvent.init();
        console.log("Webhook event index is ready");

        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    } catch (error) {
        console.error("Startup failed:", error.message);
        process.exit(1);
    }
}

startServer();
