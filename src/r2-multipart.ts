export async function completeMultipartUploadAndHead(
  bucket: R2Bucket,
  key: string,
  uploadId: string,
  parts: R2UploadedPart[]
): Promise<R2Object | null> {
  await bucket.resumeMultipartUpload(key, uploadId).complete(parts);
  return bucket.head(key);
}
