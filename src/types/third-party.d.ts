declare module 'camoufox-js' {
  export function Camoufox(options?: any): Promise<any>;
  export function NewBrowser(...args: any[]): Promise<any>;
}

declare module 'ghost-cursor' {
  export function createCursor(page: any): any;
  export type GhostCursor = any;
}
