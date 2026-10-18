# 参与贡献

谢谢你想帮忙。先说清这个项目的取舍，免得白跑一趟：

## 最欢迎的贡献

**判据的「误判复现」。** 这个工具的全部价值在于判得准，所以最有价值的贡献是：
你发现某个仓库被误判了，**带着可复现的证据**来 —— 仓库地址、哪一维、你期望的结论、
以及你认为判据应该怎么改。

判据改动请遵守三条纪律（`AGENTS.md` 里也写了）：

1. 只用客观证据：API 返回值、文件是否存在、HTTP 状态码
2. 判不了的写进 `manual` 并累加 `unverifiable`，**不要当成不满足扣分**
3. 每条结论都要有 `evidence`

改完必须跑：

```bash
bun run check      # 维度一致性 + 四路引擎维度纪律 + 单元测试
```

## 不太适合的贡献

- **加维度的 PR 请先开 issue 讨论。** 维度数不是越多越好，本项目刻意保持精简；
  加一维意味着判据、evidence 格式、报告模板、可能还有 skill 都要同步。
- **不要为了刷分改判据的及格线。** 分数是结果，不是目标。

## 提交流程

```bash
git clone git@github.com:webkubor/scorecard.git
cd scorecard
bun install
bun run build      # 生成 dist/
bun run server     # http://127.0.0.1:54445
```

改完开 PR，说明「为什么改」比「改了什么」更重要 —— 尤其是判据类的改动，
请附上你测的那个仓库的前后对比。

## 报告 bug

用 issue 模板会让处理快很多。安全问题请走
[SECURITY.md](SECURITY.md) 里的私有报告通道，不要开公开 issue。

## License

贡献即同意以 [MIT](LICENSE) 授权。
