import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const config = JSON.parse(await readFile(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8"
));

it("retains exhausted staging jobs in an isolated dead-letter queue", () => {
  const consumers = config.env.staging.queues.consumers;
  expect(consumers).toEqual([{
    queue: "dust-wave-podcast-jobs-staging",
    max_batch_size: 10,
    max_batch_timeout: 5,
    max_retries: 3,
    dead_letter_queue: "dust-wave-podcast-jobs-staging-dlq"
  }]);
  expect(
    config.env.staging.queues.producers[0].queue,
  ).not.toBe(consumers[0].dead_letter_queue);
});

it("keeps production queue behavior unchanged and environment-isolated", () => {
  const [consumer] = config.env.production.queues.consumers;
  expect(consumer.queue).toBe("dust-wave-podcast-jobs-production");
  expect(consumer.dead_letter_queue).toBeUndefined();
  expect(consumer.queue).not.toBe(
    config.env.staging.queues.consumers[0].queue
  );
  expect(consumer.queue).not.toBe(
    config.env.staging.queues.consumers[0].dead_letter_queue
  );
});
