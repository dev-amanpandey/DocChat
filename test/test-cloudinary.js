import 'dotenv/config';
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'node:stream';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const buffer = Buffer.from('DocChat Cloudinary upload test');

try {
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: `docchat-test-${Date.now()}`,
        resource_type: 'raw',
        type: 'authenticated',
      },
      (error, uploaded) => {
        if (error) return reject(error);
        resolve(uploaded);
      }
    );

    Readable.from(buffer).pipe(stream);
  });

  console.log('UPLOAD SUCCESS:', {
    publicId: result.public_id,
    resourceType: result.resource_type,
  });
}  catch (error) {
  console.error('UPLOAD FAILED:', {
    message: error.message,
    http_code: error.http_code,
    name: error.name,
    error: error.error,
    response: error.response?.data,
  });
}