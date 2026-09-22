# Browser Use with Jev

[English](README.md) · **早期 Alpha，公开迭代中**

在保留 [Browser Use](https://github.com/browser-use/browser-use) 完整执行流程的基础上，
让 Jev 优先承担能够表达为有限候选项的决策。宿主模型负责生成、复杂操作与结果核验。

这是独立项目，不是 Browser Use 官方发布的版本。Browser Use 以 Python 依赖引入，
**没有 vendor 上游源码**，也不依赖社区 `jev-browser-use` Skill 或 `jev-ultrafast`。

## 分工

| 能力 | 当前实现 |
| --- | --- |
| 点击、复选框、单选控件等 | Jev 从当前 DOM 的索引候选中选择 |
| 页面/容器滚动、后退、等待、切换标签 | Jev 选择代码构造的动作和参数 |
| 文字输入 | Jev 可以选择目标字段，宿主生成文字并通过上游执行 |
| 下拉菜单 | Jev 可选读取选项；具体选择默认交宿主，可用候选扩展接管 |
| 复杂规划、提取、上传、文件操作、视觉判断 | 保留 Browser Use 的宿主模型与工具流程 |
| 自定义工具 | 上游注册接口保持可用；有限参数工具也可提供 Jev 候选 |
| 任务完成 | Jev 仅提出核验请求，宿主判断并生成最终结果 |
| 低置信度、模型错误、动作失败 | 明确记录交接原因，交回宿主 |

首版是一个可测试的 Python 集成层。“保留”指继续使用上游机制，
不代表已对上游每项功能做端到端验证。“绝大多数决策交给 Jev”是目标，
真实接管比例、成功率、速度与成本仍需基准测试。

## 安装

```bash
git clone https://github.com/ZiyaoLi/browser-use-with-jev.git
cd browser-use-with-jev
uv sync --locked
cp .env.example .env
```

在本地 `.env` 填入 `TYPESAFE_API_KEY` 和宿主模型的 `OPENAI_API_KEY`。
配置好浏览器后，用有权限使用的模型 ID 替换下面的占位符：

```bash
uv run --env-file .env python examples/basic.py --model YOUR_HOST_MODEL_ID \
  "Open https://example.com and report its title."
```

该示例会真实调用 API 并打开浏览器。其他 OpenAI 兼容服务可传 `--base-url`；
已有 Jev 密钥文件可传 `--jev-env /path/to/credentials`。

Python 3.11+，当前锁定 `browser-use==0.13.10`。浏览器连接与安装沿用
[Browser Use 官方说明](https://github.com/browser-use/browser-use#readme)。

## 使用原有 Browser Use 模型

```python
import asyncio
from dataclasses import asdict
from browser_use import ChatOpenAI
from browser_use_with_jev import JevAgent, JevClient

async def main():
    agent = JevAgent(
        task="Open https://example.com and report its title.",
        llm=ChatOpenAI(model="gpt-4.1-mini"),  # 示例：可传入原有模型配置
        jev=JevClient.from_env("~/.jev.env"),
        # 原有 browser、tools、敏感数据、结构化输出等参数可继续传入。
    )
    history = await agent.run(max_steps=20)
    print(history.final_result())
    print(asdict(agent.routing))

asyncio.run(main())
```

上例的 `ChatOpenAI` 需要其自身 API 凭据；无需额外文本 API 的嵌入方式见下一节。
`JevClient.from_env()` 默认只读取环境变量 `TYPESAFE_API_KEY`。
显式指定文件时，兼容 dotenv 和单行原始密钥，不修改文件，不搜索其他凭据文件。

## 使用宿主 Agent 自身的生成能力

`HostModel` 接受异步回调，自己不创建模型 API 客户端，也不要求额外 API key：

```python
from browser_use_with_jev import HostModel, JevAgent, JevClient

async def infer_with_host(messages, *, output_format=None, **kwargs):
    # 由嵌入本库的 Agent 运行时实现：将消息/截图和输出 schema 交给其模型。
    # 有 output_format 时返回符合 schema 的 dict 或模型实例，否则返回字符串。
    return await your_host_runtime.infer(messages, output_format=output_format)

agent = JevAgent(
    task="Your browser task",
    llm=HostModel(infer_with_host),
    jev=JevClient.from_env("~/.jev.env"),
)
```

`your_host_runtime` 是应用需提供的接口，不是内置模块。当前尚未实现让终端进程
自动向 Codex 会话请求推理的通信桥，也没有安装新的 Skill；回调接口
不代表已自动接通当前 Codex 模型。

## 让更多工具决策交给 Jev

`candidate_provider(page, action_model)` 可返回额外的 `Candidate` 列表。
候选参数必须来自观察或宿主准备的数据，并通过当前上游动作 schema 校验。
例如，自定义业务工具只有几个可选模式，或下拉框已有明确选项时，
可直接提供完整动作供 Jev 选择。Jev 不生成任意参数、选择器或代码。

`allow_candidate(candidate)` 可以缩小 Jev 的候选范围。它只限制 Jev 委派，
不限制宿主或上游工具；全局权限和操作范围仍由工具配置及应用控制。

## 可靠性与观测

- 每次 Jev 只返回一个经过 schema 校验的动作，仍由 Browser Use 执行。
- 选择后再次读取页面，对比语义内容、DOM 节点身份、标签和滚动状态。
  页面变化则拒绝旧动作，由上游下一步重新观察；动态页面可能因此增加失败。
- 默认置信度门槛 `0.65` 是交接阈值，不是成功率保证。
- 每连续 12 次 Jev 动作交宿主复核，可用 `host_every` 调整。
- 超过候选数或上下文上限时交宿主，避免静默截断任务。
- Jev API 错误默认交宿主并记录原因；`jev_on_error="raise"` 禁用此回退。
- `routing` 记录 Jev 请求、选中动作、宿主选择调用、交接原因、错误与延迟。
  `jev_actions` 是选中数量，不是执行成功数；执行结果看上游 `history`。
  宿主提取、压缩和 judge 的独立调用不计入 `routing.host_calls`，
  不能直接把此计数当成总模型成本。

Jev 请求包含任务、上游文本消息、页面 DOM 和结果上下文，不包含截图。
宿主仍可能收到上游截图。隐私、遥测和浏览器策略沿用 Browser Use；
本项目的测试关闭遥测，不写入真实凭据，不调用付费 API。

## 开发与验证

```bash
uv run pytest -q
uv run ruff check src tests
uv run ruff format --check src tests
uv build
```

测试使用真实上游 Agent、动作 schema、自定义工具注册和宿主模型路径，
浏览器读取与 Jev API 使用替身。尚未完成真实浏览器端到端测试和性能对比。
macOS 沙箱可能因上游导入时读取显示器信息而中止，需在正常终端环境运行。

实现只覆写 `get_model_output` 与用于接收当步页面的 `_get_next_action`；
后者是上游受保护接口，因此采用精确版本锁定。升级依赖前必须跑兼容性测试。
架构与后续工作见 [docs/architecture.md](docs/architecture.md)。
