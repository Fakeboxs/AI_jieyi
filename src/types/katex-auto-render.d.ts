declare module "katex/contrib/auto-render" {
  export interface Delimiter {
    left: string;
    right: string;
    display?: boolean;
  }
  export interface RenderOptions {
    delimiters?: Delimiter[];
    throwOnError?: boolean;
    errorCallback?: (msg: string, err: Error) => void;
    ignoredTags?: string[];
    ignoredClasses?: string[];
    strict?: boolean | string | ((errorCode: string, errorMsg: string) => boolean | string);
    trust?: boolean | ((context: { command: string; url: string }) => boolean);
  }
  export default function renderMathInElement(elem: HTMLElement, options?: RenderOptions): void;
}
