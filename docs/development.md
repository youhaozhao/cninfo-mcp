# 开发与测试

在独立环境中安装运行依赖和 pytest 后执行全部 Python 与 Node 回归测试：

```bash
python3 -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
python -m pip install -r python/requirements.txt pytest
npm test
```

也可使用 uv 临时环境：

```bash
uv run --no-project --with pytest --with requests --with 'mcp~=2.1.1' npm test
```
