# 截图怎么来的

这里的 PNG 不是画出来的，是**插件自己的 `client/client.js` 在页面里真实渲染**后截的图：

1. 把 `client/client.js` 复制进来，把 React 18 的 UMD 构建（`react.production.min.js`、`react-dom.production.min.js`）放到同目录——这两个文件不入库，自己从 `node_modules/react/umd` 拷。
2. `index.html` 用假的 `window.__ModuleLoader__` 捕获注册，`harness.js` 用真实 React 挂载 `conversation.composer.dock` 的组件，并 `stub` 掉 `fetch` 让「生成」返回一份固定文档。
3. 用无头浏览器截图：

```bash
msedge --headless=new --disable-gpu --hide-scrollbars \
  --window-size=920,780 --virtual-time-budget=4000 \
  --screenshot=shot-2.png \
  "file:///<abs>/shoot/index.html?state=panel"
```

`?state=button` 只截按钮，`?state=panel` 会点一下按钮把弹层截进去，`&theme=dark` 用深色变量。

`crop.py` 去掉无头浏览器留下的白边；需要的依赖是 Pillow。
