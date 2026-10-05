import DefaultTheme from 'vitepress/theme';

import './tokens.css';
import './custom.css';

/**
 * The default theme with the Gameable look layered on. Nothing else: no
 * layout slots, no components. The palette and type live in the two CSS
 * files and `STYLE.md` says where every value comes from.
 */
export default DefaultTheme;
