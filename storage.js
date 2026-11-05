const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  ListObjectsV2Command, DeleteObjectsCommand
} = require("@aws-sdk/client-s3");

const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
for (const key of required) {
  if (!process.env[key]) throw new Error("Missing required environment variable: " + key);
}
const bucket = process.env.R2_BUCKET;
const s3 = new S3Client({
  region: "auto",
  endpoint: "https://" + process.env.R2_ACCOUNT_ID + ".r2.cloudflarestorage.com",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  },
  forcePathStyle: true
});

async function putJson(key, value) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: JSON.stringify(value),
    ContentType: "application/json; charset=utf-8"
  }));
}
async function getJson(key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await r.Body.transformToString());
  } catch (e) {
    if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}
async function putBuffer(key, body, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType || "application/octet-stream" }));
}
async function getBuffer(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await r.Body.transformToByteArray());
}
async function deleteKey(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
async function listKeys(prefix) {
  const keys = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const item of page.Contents || []) if (item.Key) keys.push(item.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}
async function deletePrefix(prefix) {
  const keys = await listKeys(prefix);
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    if (chunk.length) await s3.send(new DeleteObjectsCommand({
      Bucket: bucket, Delete: { Objects: chunk.map(Key => ({ Key })), Quiet: true }
    }));
  }
  return keys.length;
}
module.exports = { putJson, getJson, putBuffer, getBuffer, deleteKey, listKeys, deletePrefix };
