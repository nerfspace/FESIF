'use strict';
/**
 * shared/queue.js
 * BullMQ queue helpers – a thin wrapper so every service uses the same
 * queue name, connection settings, and message shape.
 */

const { Queue, Worker, QueueEvents } = require('bullmq');

const QUEUE_NAME = 'listings';

function redisConnection() {
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
  };
}

/**
 * Return a BullMQ Queue instance for publishing listing jobs.
 * The Queue object is cheap to create and can be reused across calls.
 */
function createQueue() {
  return new Queue(QUEUE_NAME, { connection: redisConnection() });
}

/**
 * Enqueue a single listing message.
 *
 * @param {Queue}  queue   BullMQ Queue instance (from createQueue)
 * @param {object} payload Must contain: listing_id, title, price,
 *                         shipping_cost, seller_feedback, category,
 *                         listing_url, timestamp_detected
 */
async function enqueueListings(queue, payload) {
  await queue.add('listing', payload, {
    // Deduplicate by listing_id so the same listing is not processed twice
    // even if the poller accidentally emits it more than once.
    // Prefix with "listing-" because BullMQ rejects purely numeric job IDs.
    jobId: `listing-${payload.listing_id}`,
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
  });
}

/**
 * Create a BullMQ Worker that processes listing jobs.
 *
 * @param {Function} processor  async (job) => void
 * @returns {Worker}
 */
function createWorker(processor) {
  const worker = new Worker(QUEUE_NAME, processor, {
    connection: redisConnection(),
    concurrency: 5,
  });

  worker.on('failed', (job, err) => {
    console.error(`[analyzer] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

module.exports = { createQueue, enqueueListings, createWorker };