import type { Plugin } from 'vite'
export declare const CODE128_BARCODE_MODULE_ID: string
export declare const CODE128_BARCODE_RESOLVED_ID: string
export declare function buildCode128BarcodeModule(source: string, version: string): string
export declare function code128BarcodePlugin(): Plugin
