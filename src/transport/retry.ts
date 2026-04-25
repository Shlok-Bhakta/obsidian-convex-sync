export type RetryOptions = {
	maxAttempts: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	jitterRatio?: number;
	shouldRetry?: (error: unknown) => boolean;
};

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.25;

const pendingTimers = new Set<AbortController>();

export async function retry<T>(
	fn: () => Promise<T>,
	options: RetryOptions,
): Promise<T> {
	const maxAttempts = Math.max(1, options.maxAttempts);
	let attempt = 0;

	for (;;) {
		attempt += 1;
		try {
			return await fn();
		} catch (error) {
			if (
				attempt >= maxAttempts ||
				(options.shouldRetry && !options.shouldRetry(error))
			) {
				throw error;
			}

			await sleep(computeRetryDelayMs(attempt, options));
		}
	}
}

export function computeRetryDelayMs(
	attempt: number,
	options: Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "jitterRatio"> = {},
): number {
	const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
	const exponentialDelay = Math.min(
		maxDelayMs,
		baseDelayMs * 2 ** Math.max(0, attempt - 1),
	);
	const jitter = exponentialDelay * jitterRatio;
	return Math.max(0, exponentialDelay - jitter + Math.random() * jitter * 2);
}

export function cancelAll(): void {
	for (const controller of pendingTimers) {
		controller.abort();
	}
	pendingTimers.clear();
}

function sleep(delayMs: number): Promise<void> {
	const controller = new AbortController();
	pendingTimers.add(controller);
	return new Promise((resolve, reject) => {
		const timeout = window.setTimeout(() => {
			pendingTimers.delete(controller);
			resolve();
		}, delayMs);
		controller.signal.addEventListener(
			"abort",
			() => {
				window.clearTimeout(timeout);
				reject(new Error("Retry cancelled"));
			},
			{ once: true },
		);
	});
}
