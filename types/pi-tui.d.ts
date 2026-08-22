declare module "@earendil-works/pi-tui" {
  export interface Component {
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate(): void;
  }

  export function matchesKey(data: string, key: string): boolean;
  export function truncateToWidth(
    text: string,
    width: number,
    ellipsis?: string,
    pad?: boolean,
  ): string;
  export function visibleWidth(text: string): number;
  export function wrapTextWithAnsi(text: string, width: number): string[];

  export class Text {
    constructor(text: string, x: number, y: number);
  }
}
