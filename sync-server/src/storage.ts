// R2 layout. Everything a user stores lives under their prefix, so deleting
// their cloud data is one prefix listing.
export const userPrefix = (userId: string) => `${userId}/`;
export const fileKey = (userId: string, fileId: string) => `${userId}/files/${fileId}`;
export const blobKey = (userId: string, blobId: string) => `${userId}/blobs/${blobId}`;
