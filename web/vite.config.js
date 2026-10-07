/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

import react from '@vitejs/plugin-react';
import { defineConfig, transformWithEsbuild } from 'vite';
import pkg from '@douyinfe/vite-plugin-semi';
import path from 'path';

const { vitePluginSemi } = pkg;

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [
    {
      name: 'treat-js-files-as-jsx',
      async transform(code, id) {
        if (!/src\/.*\.js$/.test(id)) {
          return null;
        }
        return transformWithEsbuild(code, id, {
          loader: 'jsx',
          jsx: 'automatic',
        });
      },
    },
    react(),
    vitePluginSemi({
      cssLayer: true,
    }),
  ],
  optimizeDeps: {
    esbuildOptions: {
      loader: {
        '.js': 'jsx',
        '.json': 'json',
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 4321,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4322',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.origin === 'http://127.0.0.1:4321')
              proxyReq.setHeader('Origin', 'http://127.0.0.1:4322');
          });
        },
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4321,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4322',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.origin === 'http://127.0.0.1:4321')
              proxyReq.setHeader('Origin', 'http://127.0.0.1:4322');
          });
        },
      },
    },
  },
});
