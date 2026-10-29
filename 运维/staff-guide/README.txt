《操作说明》素材与生成管线
====================================

产物（在仓库根目录）：
  操作说明.html      —— 源文件（图片已内嵌 base64，单文件可直接打开/转发）
  操作说明.pdf       —— A4 纵向 9 页，打印/转发用

和《使用手册.pdf》的区别：
  使用手册        横版 PPT 风格，面向**全员/管理视角**（含系统管理、成本、权限等）
  操作说明 竖版图文，**只讲日常要做的事**：登录 → 上传 → 等 → 看成果 → 改
                  每页一张**圈注截图**（红框圈要点、箭头指位置、编号对步骤）


界面改版后怎么重新生成（按顺序跑这四步）
----------------------------------------
0) 起一个临时影子实例（不碰生产数据），并建一个一般账号：

     $tmp = Join-Path $env:TEMP ('wbg-' + [guid]::NewGuid().ToString('N').Substring(0,8))
     New-Item -ItemType Directory -Force $tmp | Out-Null
     $env:PORT='8799'; $env:WB_DATA_DIR=$tmp
     # 另开一个窗口/后台：在 web 目录下  node server.mjs
     # 从 $tmp\server.log 里取"密  码 : xxxxxx"（初始管理员密码），然后：
     $env:WB_BASE='http://127.0.0.1:8799'
     node 运维\staff-guide\bootstrap.mjs <初始管理员密码>     # 建员工账号 + 设管理员密码

   ⚠️ 必须用 bootstrap.mjs 建账号，**不要**用 PowerShell 的 Invoke-WebRequest 拼 JSON：
      它默认按 latin-1 发中文，服务端收到的是 "??"，示例数据会挂到管理员名下（踩过）。

1) 造示例数据（假项目名 + 假问题，走真实渲染管线；文档里不会出现真实报告内容）：

     node 运维\staff-guide\demo-data.mjs $tmp 刘工

   （会同时生成 校对成果.pdf / 审核成果.pdf / 原报告标注版-校对.pdf，
     这样任务详情页显示的是"下载"链接，与员工实际看到的一致）

2) 拍图（使用者视角；同时量出每个元素的坐标 .rects.json）：

     $env:DSH_SHOT_PWD_ADMIN='guide-2026'; $env:DSH_SHOT_PWD_liugong='liu-2026'
     node 运维\screenshot.cjs 运维\staff-guide\raw 运维\staff-guide\shots.json

3) 圈注（按元素名画框/箭头/编号，配方在 annotate.py 的 RECIPES 里，不含坐标）：

     python 运维\staff-guide\annotate.py        # 需要 Pillow

4) 出 PDF，并检查有没有页面超出一页 A4：

     node 运维\staff-guide\make-guide.mjs
     node 运维\staff-guide\check-guide.mjs      # 退出码非 0 就是有页溢出，去压缩那页文字


为什么这么设计
--------------
· **按元素名圈注**，不写死像素坐标：第一版手写坐标，改一句文案整张图就歪了，只能反复试。
  现在界面改版后重跑 2、3 两步即可，配方里写的只是"圈哪个元素、标几号、写什么说明"。
· **示例数据而非真实任务**：这份说明会被打印、转发、贴群，里面不能出现真实项目与报告内容。
· **排版自动守门**：纸张排版最容易出"某页多了一行、打印被拆成两页"，check-guide.mjs 专门量这个。
