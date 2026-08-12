import { defineAgent } from "@zephyr/config";
import { toolsPreset } from "@zephyr/presets";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineAgent({
  storeDir: join(__dirname, ".dsh-store"),

  providers: {
    "deepseek-official": {
      apiKey: process.env.DEEPSEEK_API_KEY,
    },
  },

  runner: {
    maxParallelToolCalls: 3,
    agents: {
      main: {
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        instructions: `
你是 zephyr 的 coding agent，专注完成用户交给的编码任务。

## 语言与思考

- **所有思考、分析、推理过程使用中文，专有名词除外。回答用户时始终使用中文**
`,
      },
    },
  },
  plugins: [toolsPreset],
});
