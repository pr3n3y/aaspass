import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: required('DATABASE_URL'),
  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  otpPepper: required('OTP_PEPPER'),
  smsProvider: process.env.SMS_PROVIDER ?? 'console',
  pushProvider: process.env.PUSH_PROVIDER ?? 'console',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  msg91AuthKey: process.env.MSG91_AUTH_KEY ?? '',
  msg91TemplateId: process.env.MSG91_TEMPLATE_ID ?? '',
  fcmProjectId: process.env.FCM_PROJECT_ID ?? '',
  googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '',
  s3Endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  s3PublicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? 'http://10.0.2.2:9000',
  s3Bucket: process.env.S3_BUCKET ?? 'aaspaas',
  s3AccessKey: process.env.S3_ACCESS_KEY ?? 'minio',
  s3SecretKey: process.env.S3_SECRET_KEY ?? 'minio12345',
  s3Region: process.env.S3_REGION ?? 'us-east-1',
};

export const CONSENT_VERSION = '2026-11-04';
export const OTP_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TTL = '15m';
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
