
const mongoose = require("mongoose");

const webhookEventSchema = new mongoose.Schema(
    {
        eventId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },

        eventType: {
            type: String,
            required: true
        },

        status: {
            type: String,
            enum: [
                "received",
                "processing",
                "processed",
                "failed"
            ],
            default: "received",
            required: true
        },

        payload: {
            type: mongoose.Schema.Types.Mixed,
            required: true
        },

        attempts: {
            type: Number,
            default: 0
        },

        lastError: {
            type: String,
            default: null
        },

        processedAt: {
            type: Date,
            default: null
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model(
    "WebhookEvent",
    webhookEventSchema
);
