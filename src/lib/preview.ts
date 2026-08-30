/**
 * How long a pre-listen runs before it stops itself.
 *
 * The cap is a clock on the <audio> element, not a cut of the file: the
 * bucket keeps the DJ's original upload whole, the length is one number to
 * change here, and because the element is preload="none" and R2 answers
 * range requests, a phone only fetches roughly the part it plays.
 *
 * It bounds what the app offers to play, not what the signed URL addresses —
 * the whole object is still one request away for anyone reading the network
 * tab. That is fine while this is a matter of taste (a pre-listen is a taste
 * of a song, not the song); a rights limit would have to be enforced by the
 * preview route serving bounded bytes instead of redirecting.
 */
export const previewSeconds = 30;
