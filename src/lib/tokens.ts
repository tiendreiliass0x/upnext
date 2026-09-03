/**
 * Where the browser keeps each credential, and the header the admin one
 * travels in.
 *
 * Kept apart from lib/admin, which reaches for node:crypto to compare the
 * secret and so cannot be imported from a component. A key written out again
 * per component is a rename that compiles cleanly and drops the credential at
 * runtime, which looks like being signed out rather than like a typo.
 */
export const accountTokenStorageKey = "upnext-account-token";
export const adminTokenStorageKey = "upnext-admin-token";
export const adminTokenHeader = "x-upnext-admin-token";
