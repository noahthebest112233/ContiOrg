require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const ejs = require('ejs');
const multer = require('multer');
const nodemailer = require('nodemailer');

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
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`; // 添加基础URL配置

// 配置邮件发送
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || 'ContiTechOrg@gmail.com',
        pass: process.env.EMAIL_PASS
    },
    debug: true,
    logger: true,
    secure: true
});

// 验证邮件配置
transporter.verify(function(error, success) {
    if (error) {
        console.error('邮件服务配置错误:', error);
        console.error('请检查 EMAIL_USER 和 EMAIL_PASS 配置');
        console.error('当前配置:', {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS ? '已设置' : '未设置'
        });
    } else {
        console.log('邮件服务配置成功，准备发送邮件');
    }
});

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

        // 在数据库初始化部分添加订阅者表
        db.run(`CREATE TABLE IF NOT EXISTS subscribers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            status TEXT DEFAULT 'active',
            subscription_date TEXT NOT NULL
        )`);
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

// 订阅相关的数据库函数
async function addSubscriber(email) {
    return new Promise((resolve, reject) => {
        const date = new Date().toISOString();
        
        // 先检查是否存在
        db.get('SELECT * FROM subscribers WHERE email = ?', [email], (err, row) => {
            if (err) {
                reject(err);
                return;
            }
            
            if (row) {
                if (row.status === 'inactive') {
                    // 如果存在但是未激活，则重新激活
                    db.run(
                        'UPDATE subscribers SET status = ?, subscription_date = ? WHERE email = ?',
                        ['active', date, email],
                        function(err) {
                            if (err) reject(err);
                            else resolve(this.lastID);
                        }
                    );
                } else {
                    reject(new Error('该邮箱已经订阅'));
                }
            } else {
                // 如果不存在，创建新订阅
                db.run(
                    'INSERT INTO subscribers (email, status, subscription_date) VALUES (?, ?, ?)',
                    [email, 'active', date],
                    function(err) {
                        if (err) reject(err);
                        else resolve(this.lastID);
                    }
                );
            }
        });
    });
}

async function removeSubscriber(email) {
    return new Promise((resolve, reject) => {
        db.run(
            'UPDATE subscribers SET status = ? WHERE email = ?',
            ['inactive', email],
            function(err) {
                if (err) {
                    reject(err);
                } else if (this.changes === 0) {
                    reject(new Error('未找到该订阅邮箱'));
                } else {
                    resolve(true);
                }
            }
        );
    });
}

async function getActiveSubscribers() {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT email FROM subscribers WHERE status = ?',
            ['active'],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows.map(row => row.email));
            }
        );
    });
}

// 订阅路由
app.post('/api/subscribe', async (req, res) => {
    try {
        const { email } = req.body;
        console.log('收到订阅请求:', email);
        
        if (!email) {
            console.log('订阅失败：邮箱地址为空');
            return res.status(400).json({ success: false, error: '邮箱地址不能为空' });
        }

        console.log('开始添加订阅者到数据库...');
        await addSubscriber(email);
        console.log('订阅者添加成功');
        
        // 发送欢迎邮件
        try {
            console.log('开始发送欢迎邮件...');
            const info = await transporter.sendMail({
                from: {
                    name: 'CONTI News',
                    address: process.env.EMAIL_USER || 'ContiTechOrg@gmail.com'
                },
                to: email,
                subject: '欢迎订阅 CONTI 新闻',
                html: `
                    <h2>感谢您订阅 CONTI 新闻！</h2>
                    <p>您将收到我们的最新动态和更新。</p>
                    <p>如果想要取消订阅，请访问我们的网站。</p>
                `
            });
            console.log('欢迎邮件发送成功:', info.response);
            console.log('预览URL:', nodemailer.getTestMessageUrl(info));
        } catch (emailError) {
            console.error('发送欢迎邮件失败:', emailError);
            // 继续执行，不影响订阅流程
        }

        res.json({ success: true, message: '订阅成功' });
    } catch (error) {
        console.error('订阅处理失败:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/unsubscribe', async (req, res) => {
    try {
        const { email } = req.body;
        console.log('收到取消订阅请求:', email);
        
        if (!email) {
            console.log('取消订阅失败：邮箱地址为空');
            return res.status(400).json({ success: false, error: '邮箱地址不能为空' });
        }

        console.log('开始从数据库中更新订阅状态...');
        await removeSubscriber(email);
        console.log('订阅状态更新成功');

        res.json({ success: true, message: '已取消订阅' });
    } catch (error) {
        console.error('取消订阅处理失败:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

// 添加一个用于测试的路由，查看所有订阅者
app.get('/api/subscribers', async (req, res) => {
    try {
        const subscribers = await new Promise((resolve, reject) => {
            db.all('SELECT * FROM subscribers', [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
        res.json({ success: true, subscribers });
    } catch (error) {
        console.error('获取订阅者列表失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 修改新闻发布路由，添加邮件通知
const oldPostNews = app.post.bind(app, '/api/admin/news');
app.post('/api/admin/news', authenticateToken, upload.single('image'), async (req, res) => {
    try {
        console.log('收到新闻发布请求');
        console.log('请求体:', req.body);
        console.log('文件信息:', req.file);

        const { title, content } = req.body;
        const image_url = req.file ? `/uploads/${req.file.filename}` : null;

        console.log('准备插入数据库的数据:', {
            title,
            content,
            image_url
        });

        const stmt = db.prepare('INSERT INTO news (title, content, image_url, date) VALUES (?, ?, ?, ?)');
        try {
            const result = stmt.run(title, content, image_url, new Date().toISOString());
            console.log('数据库插入结果:', result);

            // 获取活跃订阅者并发送邮件通知
            try {
                const subscribers = await getActiveSubscribers();
                console.log('正在向订阅者发送通知:', subscribers);

                if (subscribers.length > 0) {
                    const mailOptions = {
                        from: {
                            name: 'CONTI News',
                            address: process.env.EMAIL_USER || 'ContiTechOrg@gmail.com'
                        },
                        subject: `CONTI 新闻更新: ${title}`,
                        html: `
                            <h2>${title}</h2>
                            <p>${content}</p>
                            ${image_url ? `<img src="${BASE_URL}${image_url}" alt="新闻图片" style="max-width: 600px;">` : ''}
                            <p><a href="${BASE_URL}/news">查看更多新闻</a></p>
                            <hr>
                            <p>如果想要取消订阅，请访问我们的网站。</p>
                        `
                    };

                    // 分别发送给每个订阅者
                    for (const email of subscribers) {
                        try {
                            mailOptions.to = email;
                            console.log(`正在发送邮件到: ${email}`);
                            const info = await transporter.sendMail(mailOptions);
                            console.log('邮件发送成功:', info.response);
                            console.log('预览URL:', nodemailer.getTestMessageUrl(info));
                        } catch (emailError) {
                            console.error('发送邮件失败:', email);
                            console.error('错误详情:', emailError);
                        }
                    }
                }
            } catch (emailError) {
                console.error('处理邮件通知时出错:', emailError);
                // 不影响新闻发布的成功状态
            }

            res.json({ success: true, message: '新闻发布成功' });
        } catch (dbError) {
            console.error('数据库错误:', dbError);
            res.status(500).json({ success: false, error: '数据库操作失败: ' + dbError.message });
        }
    } catch (error) {
        console.error('服务器错误:', error);
        res.status(500).json({ success: false, error: '发布新闻失败: ' + error.message });
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
        
        // 检查端口占用情况
        exec(`netstat -ano | findstr :${port}`, (error, stdout, stderr) => {
            if (error) {
                // 如果执行命令出错，可能是端口未被占用
                console.log(`端口 ${port} 未被占用`);
                resolve();
                return;
            }

            if (stdout) {
                const lines = stdout.split('\n');
                for (const line of lines) {
                    // 只处理 LISTENING 状态的连接
                    if (line.includes('LISTENING')) {
                        const match = line.match(/\s+(\d+)\s*$/);
                        if (match && match[1] && match[1] !== '0') {
                            const pid = match[1];
                            console.log(`发现端口 ${port} 被进程 ${pid} 占用，尝试释放...`);
                            
                            exec(`taskkill /F /PID ${pid}`, (killError, killStdout, killStderr) => {
                                if (killError) {
                                    console.error(`无法释放端口 ${port}:`, killError);
                                    // 尝试使用其他端口
                                    const newPort = port + 1;
                                    console.log(`尝试使用新端口: ${newPort}`);
                                    process.env.PORT = newPort;
                                    resolve();
                                } else {
                                    console.log(`成功释放端口 ${port}`);
                                    setTimeout(resolve, 1000);
                                }
                            });
                            return;
                        }
                    }
                }
            }
            // 如果没有找到 LISTENING 状态的连接，说明端口可用
            console.log(`端口 ${port} 可用`);
            resolve();
        });
    });
}

// 修改服务器启动函数
const startServer = async (port) => {
    console.log('----------------------------------------');
    console.log('正在启动服务器...');
    
    try {
        // 确保uploads文件夹存在
        const uploadsDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadsDir)) {
            console.log('创建uploads文件夹...');
            fs.mkdirSync(uploadsDir);
            console.log('uploads文件夹创建成功');
        }
        
        // 先检查并释放端口
        await checkAndReleasePort(port);
        
        // 获取最终使用的端口（可能在checkAndReleasePort中被修改）
        const finalPort = process.env.PORT || port;
        console.log(`尝试在端口 ${finalPort} 上启动服务器`);
        
        // 等待一小段时间再启动服务器
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const server = app.listen(finalPort, () => {
            console.log('----------------------------------------');
            console.log(`服务器成功启动！`);
            console.log(`访问地址: http://localhost:${finalPort}`);
            console.log(`测试路由: http://localhost:${finalPort}/api/test-db`);
            console.log('----------------------------------------');
        });

        // 添加优雅关闭处理
        process.on('SIGINT', () => {
            console.log('正在关闭服务器...');
            server.close(() => {
                console.log('服务器已关闭');
                db.close((err) => {
                    if (err) {
                        console.error('关闭数据库时出错:', err);
                        process.exit(1);
                    }
                    console.log('数据库连接已关闭');
                    process.exit(0);
                });
            });
        });

        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error('----------------------------------------');
                console.error(`端口 ${finalPort} 被占用，请尝试使用其他端口`);
                console.error('可以通过设置环境变量 PORT 来指定其他端口');
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
