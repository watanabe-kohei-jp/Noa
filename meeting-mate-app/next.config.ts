import type { NextConfig } from "next";

const BACKEND_PORT = process.env.BACKEND_PORT || '8001';
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

const nextConfig: NextConfig = {
  // 本番ビルド時のみ静的エクスポートを有効にする
  ...(process.env.NODE_ENV === 'production' && process.env.NEXT_EXPORT === 'true' ? {
    output: 'export',
    trailingSlash: true,
    distDir: 'out',
  } : {
    // 開発環境では動的ルーティングのためのrewritesを設定
    async rewrites() {
      return [
        {
          source: '/room/:roomId',
          destination: '/room',
        },
        // 開発環境でのバックエンドAPIプロキシ（localhost FastAPIへ）
        {
          source: '/invoke',
          destination: `${BACKEND_URL}/invoke`,
        },
        {
          source: '/join_room',
          destination: `${BACKEND_URL}/join_room`,
        },
        {
          source: '/approve_join_request',
          destination: `${BACKEND_URL}/approve_join_request`,
        },
        {
          source: '/create_room',
          destination: `${BACKEND_URL}/create_room`,
        },
        {
          source: '/stt',
          destination: `${BACKEND_URL}/stt`,
        },
        {
          source: '/tts',
          destination: `${BACKEND_URL}/tts`,
        },
        {
          source: '/api/config',
          destination: `${BACKEND_URL}/api/config`,
        },
        {
          source: '/api/deep-analysis',
          destination: `${BACKEND_URL}/api/deep-analysis`,
        },
        {
          source: '/api/brain',
          destination: `${BACKEND_URL}/api/brain`,
        },
        {
          source: '/api/sessions/:path*',
          destination: `${BACKEND_URL}/api/sessions/:path*`,
        },
        {
          source: '/api/memory/:path*',
          destination: `${BACKEND_URL}/api/memory/:path*`,
        },
        {
          source: '/api/vision/:path*',
          destination: `${BACKEND_URL}/api/vision/:path*`,
        },
      ];
    },
  }),
  /* config options here */
};

export default nextConfig;
