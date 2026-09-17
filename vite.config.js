import { enterDevPlugin } from "vite-plugin-enter-dev";
import { enterProdPlugin } from "vite-plugin-enter-dev";
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ...enterProdPlugin(), ...enterDevPlugin({
    react: false
  })]
});
