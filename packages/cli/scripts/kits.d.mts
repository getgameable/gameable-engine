/** One multiplayer kit under `templates/`. */
export interface Kit {
  /** Relative directory, such as `templates/mystery`. */
  readonly dir: string;
  /** Its `/play/<name>/` segment: the directory name. */
  readonly name: string;
  /** The room server's name for it: the package name without the scope. */
  readonly catalog: string;
}

/** The repository root, forward-slashed. */
export declare const ROOT: string;

/** True when a `src/game.ts` declares `features.multiplayer`. */
export declare function declaresMultiplayer(source: string): boolean;

/** A package name without its npm scope. */
export declare function catalogNameOf(packageName: string): string;

/** Every multiplayer kit, sorted by directory. */
export declare function multiplayerKits(root?: string): Kit[];

/** Build every kit's guest and pack it into `<gamesDir>/<catalog>/dist`. */
export declare function packKits(gamesDir: string, packer: string, root?: string): Kit[];
