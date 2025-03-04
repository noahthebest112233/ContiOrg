const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const ejs = require('ejs');
const multer = require('multer');

// 配置文件上传
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = 'uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 限制5MB
    },
    fileFilter: function (req, file, cb) {
        if (!file.originalname.match(/\.(jpg|jpeg|png|gif|bmp)$/i)) {
            return cb(new Error('只允许上传图片文件！(支持jpg、jpeg、png、gif、bmp格式)'));
        }
        cb(null, true);
    }
});

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const ADMIN_PASSWORD = 'ContiTechOrg$%GFEH&*31HSc88JCEBSKkEcesf';

// 创建数据库连接
const db = new sqlite3.Database('news.db', (err) => {
    if (err) {
        console.error('----------------------------------------');
        console.error('数据库连接错误:', err);
        console.error('----------------------------------------');
        process.exit(1);
    } else {
        console.log('----------------------------------------');
        console.log('成功连接到数据库');
        
        // 检查表结构并进行迁移
        db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='news'", (err, row) => {
            if (err) {
                console.error('检查表结构失败:', err);
                process.exit(1);
            }
            
            if (row && !row.sql.includes('image_url')) {
                console.log('检测到旧版表结构，正在进行迁移...');
                // 备份旧数据
                db.serialize(() => {
                    db.run("ALTER TABLE news RENAME TO news_old");
                    // 创建新表
                    db.run(`CREATE TABLE news (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        title TEXT NOT NULL,
                        content TEXT NOT NULL,
                        image_url TEXT,
                        date TEXT NOT NULL
                    )`, (err) => {
                        if (err) {
                            console.error('创建新表失败:', err);
                            process.exit(1);
                        }
                        // 迁移数据
                        db.run("INSERT INTO news (id, title, content, date) SELECT id, title, content, date FROM news_old", (err) => {
                            if (err) {
                                console.error('数据迁移失败:', err);
                                process.exit(1);
                            }
                            // 删除旧表
                            db.run("DROP TABLE news_old", (err) => {
                                if (err) {
                                    console.error('删除旧表失败:', err);
                                    process.exit(1);
                                }
                                console.log('数据库迁移完成');
                                startServer(PORT);
                            });
                        });
                    });
                });
            } else if (!row) {
                // 如果表不存在，创建新表
                db.run(`CREATE TABLE IF NOT EXISTS news (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    image_url TEXT,
                    date TEXT NOT NULL
                )`, (err) => {
                    if (err) {
                        console.error('创建表失败:', err);
                        process.exit(1);
                    } else {
                        console.log('数据库表创建成功');
                        startServer(PORT);
                    }
                });
            } else {
                // 表结构已经是最新的
                console.log('数据库表结构已是最新');
                startServer(PORT);
            }
        });
    }
});

// 数据库操作函数
async function saveToDatabase(newsItem) {
    return new Promise((resolve, reject) => {
        console.log('开始数据库保存操作');
        const { title, content, image_url, date } = newsItem;
        
        if (!title || !content || !date) {
            const error = new Error('缺少必要的新闻数据');
            console.error('数据库验证失败:', error);
            reject(error);
            return;
        }

        db.run(
            'INSERT INTO news (title, content, image_url, date) VALUES (?, ?, ?, ?)',
            [title, content, image_url, date],
            function(err) {
                if (err) {
                    console.error('数据库插入失败:', err);
                    reject(err);
                } else {
                    console.log('数据库插入成功，ID:', this.lastID);
                    resolve(this.lastID);
                }
            }
        );
    });
}

async function getNewsFromDatabase() {
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM news ORDER BY date DESC', [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// 更新HTML文件的函数
async function updateNewsHtmlFile() {
    try {
        console.log('开始更新HTML文件');
        const news = await getNewsFromDatabase();
        console.log('获取到新闻数据:', news.length, '条');
        
        const templatePath = path.join(__dirname, 'views', 'news.ejs');
        if (!fs.existsSync(templatePath)) {
            throw new Error('找不到模板文件: ' + templatePath);
        }
        
        const template = fs.readFileSync(templatePath, 'utf8');
        const html = ejs.render(template, { news });
        
        const outputPath = path.join(__dirname, 'news.html');
        fs.writeFileSync(outputPath, html);
        console.log('HTML文件更新成功:', outputPath);
    } catch (error) {
        console.error('更新HTML文件失败:', error);
        throw error;
    }
}

// 中间件
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static('uploads')); // 提供图片访问
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 根路由测试
app.get('/', (req, res) => {
    res.json({ message: '服务器正在运行' });
});

// 测试数据库连接
app.get('/api/test-db', async (req, res) => {
    try {
        console.log('开始数据库测试...');
        // 测试插入
        const testNews = {
            title: '测试新闻',
            content: '这是一条测试新闻',
            date: new Date().toISOString()
        };
        
        console.log('准备插入测试数据:', testNews);
        const id = await saveToDatabase(testNews);
        console.log('测试数据插入成功，ID:', id);
        
        // 测试查询
        console.log('准备查询数据...');
        const news = await getNewsFromDatabase();
        console.log('测试数据查询成功，新闻数量:', news.length);
        
        res.json({ 
            success: true, 
            message: '数据库测试成功',
            newsCount: news.length,
            latestNews: news[0]
        });
    } catch (error) {
        console.error('数据库测试失败:', error);
        res.status(500).json({ 
            success: false, 
            error: '数据库测试失败',
            details: error.message
        });
    }
});

// 验证 JWT token 的中间件
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: '未授权访问' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: '无效的token' });
        }
        req.user = user;
        next();
    });
};

// 登录路由
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;

    if (password === ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, error: '密码错误' });
    }
});

// 新闻管理路由
let newsItems = [];

app.post('/api/admin/news', authenticateToken, upload.single('image'), async (req, res) => {
    try {
        // 设置响应类型为 JSON
        res.setHeader('Content-Type', 'application/json');
        
        console.log('收到新闻发布请求:', req.body);
        console.log('文件信息:', req.file);
        
        const { title, content } = req.body;
        if (!title || !content) {
            throw new Error('标题和内容不能为空');
        }

        const image_url = req.file ? `/uploads/${req.file.filename}` : null;
        
        const newsItem = {
            title,
            content,
            image_url,
            date: new Date().toISOString()
        };
        
        console.log('准备保存到数据库:', newsItem);
        const id = await saveToDatabase(newsItem);
        newsItem.id = id;
        
        console.log('数据库保存成功，准备更新HTML文件');
        try {
            await updateNewsHtmlFile();
            console.log('HTML文件更新成功');
        } catch (htmlError) {
            console.error('HTML文件更新失败，但新闻已保存:', htmlError);
            // 继续执行，不中断流程
        }
        
        console.log('新闻发布成功');
        return res.json({ success: true, newsItem });
    } catch (error) {
        console.error('发布新闻失败，详细错误:', error);
        if (req.file) {
            try {
                fs.unlinkSync(req.file.path);
                console.log('已删除上传的文件');
            } catch (unlinkError) {
                console.error('删除文件失败:', unlinkError);
            }
        }
        return res.status(500).json({ 
            success: false, 
            error: '发布新闻失败',
            details: error.message 
        });
    }
});

app.get('/api/admin/news', authenticateToken, async (req, res) => {
    try {
        const news = await getNewsFromDatabase();
        res.json(news);
    } catch (error) {
        console.error('获取新闻列表失败:', error);
        res.status(500).json({ error: '获取新闻列表失败' });
    }
});

// 动态新闻页面路由
app.get('/news', async (req, res) => {
    try {
        const news = await getNewsFromDatabase();
        res.render('news', { news });
    } catch (error) {
        console.error('渲染新闻页面失败:', error);
        res.status(500).send('服务器错误');
    }
});

// 更新新闻
app.put('/api/admin/news/:id', authenticateToken, upload.single('image'), async (req, res) => {
    try {
        const { id } = req.params;
        const { title, content, currentImage } = req.body;
        const image_url = req.file ? `/uploads/${req.file.filename}` : currentImage;
        const date = new Date().toISOString();

        // 如果上传了新图片，删除旧图片
        if (req.file && currentImage) {
            const oldImagePath = path.join(__dirname, currentImage);
            if (fs.existsSync(oldImagePath)) {
                fs.unlinkSync(oldImagePath);
            }
        }

        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE news SET title = ?, content = ?, image_url = ?, date = ? WHERE id = ?',
                [title, content, image_url, date, id],
                function(err) {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });

        await updateNewsHtmlFile();
        res.json({ success: true });
    } catch (error) {
        console.error('更新新闻失败:', error);
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ success: false, error: '更新新闻失败' });
    }
});

// 删除新闻
app.delete('/api/admin/news/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        await new Promise((resolve, reject) => {
            db.run('DELETE FROM news WHERE id = ?', [id], function(err) {
                if (err) reject(err);
                else resolve();
            });
        });

        await updateNewsHtmlFile();
        res.json({ success: true });
    } catch (error) {
        console.error('删除新闻失败:', error);
        res.status(500).json({ success: false, error: '删除新闻失败' });
    }
});

// 检查端口是否被占用并释放
function checkAndReleasePort(port) {
    return new Promise((resolve, reject) => {
        const { exec } = require('child_process');
        
        // 直接检查端口占用情况
        exec(`netstat -ano | findstr :${port}`, (error, stdout, stderr) => {
            if (stdout) {
                // 使用正则表达式匹配 PID
                const lines = stdout.split('\n');
                for (const line of lines) {
                    const match = line.match(/\s+(\d+)\s*$/);
                    if (match && match[1]) {
                        const pid = match[1];
                        console.log(`发现端口 ${port} 被进程 ${pid} 占用，尝试释放...`);
                        exec(`taskkill /F /PID ${pid}`, (error, stdout, stderr) => {
                            if (error) {
                                console.error(`无法释放端口 ${port}:`, error);
                                reject(error);
                            } else {
                                console.log(`成功释放端口 ${port}`);
                                // 等待一小段时间确保端口完全释放
                                setTimeout(resolve, 1000);
                            }
                        });
                        return;
                    }
                }
            }
            // 如果没有找到占用，直接返回
            resolve();
        });
    });
}

// 修改服务器启动函数
const startServer = async (port) => {
    console.log('----------------------------------------');
    console.log('正在启动服务器...');
    console.log(`尝试在端口 ${port} 上启动服务器`);
    
    try {
        // 先检查并释放端口
        await checkAndReleasePort(port);
        
        // 等待一小段时间再启动服务器
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const server = app.listen(port, () => {
            console.log('----------------------------------------');
            console.log(`服务器成功启动！`);
            console.log(`访问地址: http://localhost:${port}`);
            console.log(`测试路由: http://localhost:${port}/api/test-db`);
            console.log('----------------------------------------');
        });

        // 添加错误处理
        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error('----------------------------------------');
                console.error(`严重错误：端口 ${port} 仍然被占用`);
                console.error('请手动终止占用端口的进程后重试');
                console.error('----------------------------------------');
                process.exit(1);
            } else {
                console.error('服务器错误:', error);
            }
        });

    } catch (error) {
        console.error('----------------------------------------');
        console.error('服务器启动失败');
        console.error('错误详情:', error);
        console.error('----------------------------------------');
        process.exit(1);
    }
};
