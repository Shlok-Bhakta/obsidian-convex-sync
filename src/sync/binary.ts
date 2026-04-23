const TEXT_SAMPLE_BYTES = 4096;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type ContentKind = "text" | "binary";

function hasUtf16Bom(sample: Uint8Array): boolean {
	return (
		(sample.length >= 2 &&
			((sample[0] === 0xfe && sample[1] === 0xff) ||
				(sample[0] === 0xff && sample[1] === 0xfe))) ||
		(sample.length >= 4 &&
			((sample[0] === 0x00 &&
				sample[1] === 0x00 &&
				sample[2] === 0xfe &&
				sample[3] === 0xff) ||
				(sample[0] === 0xff &&
					sample[1] === 0xfe &&
					sample[2] === 0x00 &&
					sample[3] === 0x00)))
	);
}

function sliceSample(bytes: Uint8Array): Uint8Array {
	return bytes.length <= TEXT_SAMPLE_BYTES
		? bytes
		: bytes.subarray(0, TEXT_SAMPLE_BYTES);
}

export function detectContentKind(
	input: ArrayBuffer | Uint8Array,
): ContentKind {
	const bytes =
		input instanceof Uint8Array ? input : new Uint8Array(input);
	if (bytes.length === 0) {
		return "text";
	}

	const sample = sliceSample(bytes);
	if (hasUtf16Bom(sample)) {
		return "text";
	}

	let suspicious = 0;
	for (const byte of sample) {
		if (byte === 0x00) {
			return "binary";
		}
		const isCommonWhitespace =
			byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d;
		const isPrintableAscii = byte >= 0x20 && byte <= 0x7e;
		const isAllowedControl = isCommonWhitespace || isPrintableAscii;
		if (!isAllowedControl && byte < 0x80) {
			suspicious += 1;
		}
	}

	if (suspicious / sample.length > 0.15) {
		return "binary";
	}

	try {
		UTF8_DECODER.decode(sample);
		return "text";
	} catch {
		return "binary";
	}
}
