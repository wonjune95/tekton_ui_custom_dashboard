/*
Copyright 2023-2025 The Tekton Authors
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import svgr from 'vite-plugin-svgr';
import yaml from '@rollup/plugin-yaml';

const customAPIDomain = process.env.API_DOMAIN;

const proxyConfig = {
  changeOrigin: !!customAPIDomain,
  target: customAPIDomain || 'http://localhost:9097'
};

export default defineConfig(({ mode }) => ({
  root: './',
  base: './',
  build: {
    // Relative to outDir
    assetsDir: '.',
    // Relative to the root
    outDir: 'cmd/dashboard/kodata',
    target: 'es2022'
  },
  css: {
    devSourcemap: true,
    preprocessorOptions: {
      scss: {
        quietDeps: true
      }
    }
  },
  esbuild: {
    target: 'es2022'
  },
  plugins: [react({ devTarget: 'es2022' }), svgr(), yaml()],
  resolve: {
    extensions: ['.js', '.jsx']
  },
  server: {
    headers: {
      // https://github.com/codemirror/codemirror5/issues/6707
      // style-src blob: 'nonce-tkn-dev';
      'Content-Security-Policy':
        "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; connect-src 'self' wss: ws:; font-src 'self' https://1.www.s81c.com;"
    },
    open: mode !== 'test',
    port: process.env.PORT || 8000,
    proxy: {
      // 1) 가장 위에 두기
      '/results-api': {
        target: 'https://127.0.0.1:8080',
        changeOrigin: true,
        secure: false,
        rewrite: p => p.replace(/^\/results-api/, '')
      },
      // 2) 그 다음에 나머지
      '/v1': proxyConfig,
      '/api': {
        ...proxyConfig,
        ws: true
      }
    },
    strictPort: mode !== 'test',
    watch: {
      ignored: ['**/coverage/**', '**/storybook-static/**']
    }
  },
  test: {
    clearMocks: true,
    coverage: {
      all: false,
      clean: true,
      enabled: true,
      provider: 'istanbul',
      reporter: ['text', 'html'],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90
      }
    },
    environment: 'jsdom',
    globals: true,
    restoreMocks: true,
    // slowTestThreshold: <num> // millis
    server: {
      deps: {
        inline: ['@uiw/react-codemirror']
      }
    },
    setupFiles: '/config_frontend/setupTests.js'
  }
}));
