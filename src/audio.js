/**
 * Convert Twilio's raw 8 kHz G.711 mu-law audio into raw signed 16-bit,
 * little-endian PCM at 16 kHz, the format required by Inworld streaming STT.
 *
 * Telephone audio only contains 8 kHz worth of information. Repeating samples
 * satisfies the required 16 kHz wire format; it does not invent extra detail.
 */
export function twilioMulaw8kToLinear16k(base64Payload) {
  const mulaw = Buffer.from(base64Payload, "base64");
  const pcm = Buffer.allocUnsafe(mulaw.length * 4);

  for (let index = 0; index < mulaw.length; index += 1) {
    const sample = decodeMulawSample(mulaw[index]);
    const outputOffset = index * 4;
    pcm.writeInt16LE(sample, outputOffset);
    pcm.writeInt16LE(sample, outputOffset + 2);
  }

  return pcm.toString("base64");
}

function decodeMulawSample(byte) {
  const value = (~byte) & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}
