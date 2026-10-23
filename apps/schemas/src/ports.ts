/**
 * 端口段位（面板 / 实例 / RCON）。
 *
 * 服务端据此分配端口并生成 server.properties，前端据此告诉用户去云控制台放行哪几段。
 * 各写一份时改分配器不会有任何门禁变红，而用户照着界面上的段位放行，实例仍然连不上。
 */
export const PANEL_PORT = 25566
export const GAME_PORT_START = 25567
export const GAME_PORT_COUNT = 100
export const RCON_PORT_START = 35575

/** game 段末端口（含） */
export const GAME_PORT_END = GAME_PORT_START + GAME_PORT_COUNT - 1

/** rcon 段与 game 段等长且隔开，不共享取模基数，避免一个实例的 rcon 占掉别人的 game 端口 */
export const RCON_PORT_END = RCON_PORT_START + GAME_PORT_COUNT - 1
