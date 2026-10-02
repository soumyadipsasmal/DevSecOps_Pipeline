-- KaliNova publishes under a single author. There are no user accounts, so
-- this is the only row the articles can point at.
INSERT INTO users (username, email, password_hash, avatar_url, bio)
VALUES
    ('kalinova', 'soumyadipsasmal88@gmail.com', '', 'https://i.pravatar.cc/64?img=12', 'Stories on entertainment, style, news, wildlife and travel.')
ON CONFLICT (username) DO NOTHING;

INSERT INTO articles (author_id, title, slug, content, cover_image, category_id, is_featured, is_trending, status, published_at)
SELECT
    u.id,
    seed.title,
    seed.slug,
    seed.content,
    seed.cover_image,
    c.id,
    seed.is_featured,
    seed.is_trending,
    'published',
    NOW() - (seed.age_hours || ' hours')::INTERVAL
FROM (
    VALUES
        ('kalinova',  'The Cinematography That Made a Debut Feel Like a Classic', 'the-cinematography-that-made-a-debut-feel-like-a-classic', 'A young director''s debut leaned on natural light, hand-held framing, and a refusal to cut away from an actor''s face. The result is the kind of film that quietly rewrites what a first feature is allowed to look like. Read the full breakdown on KaliNova.', 'https://images.unsplash.com/photo-1485846234645-a62644f84728?w=800&q=60', 'bollywood', true,  true,  2),
        ('kalinova',   'Why This Ensemble Cast Outperformed the Script', 'why-this-ensemble-cast-outperformed-the-script', 'When every character has a reason to exist, a sprawling cast stops competing with itself. This is a look at the chemistry that carried a season finale, and why viewers stayed.', 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=800&q=60', 'bollywood', true,  true,  6),
        ('kalinova',  'Six Rings of Change: How Regional Cinema Found Its Voice', 'six-rings-of-change-regional-cinema', 'Across six decades a parallel film industry built its own grammar, its own star system, and its own audience. A short history of the movement that changed how a country watches movies.', 'https://images.unsplash.com/photo-1500462918059-b1a0cb512f1d?w=800&q=60', 'tollywood', false, true,  10),
        ('kalinova',  'Sustainable Fabrics Are Quietly Rewriting the Runway', 'sustainable-fabrics-rewriting-the-runway', 'The most interesting designers are not chasing novelty. They are rebuilding supply chains, and the clothes are only the visible part of a much larger shift.', 'https://images.unsplash.com/photo-1441984904996-e0b6ba687e04?w=800&q=60', 'fashion', false, true,  14),
        ('kalinova',  'The Return of Hand-Done Embroidery', 'the-return-of-hand-done-embroidery', 'Slow fashion is not a trend cycle, it is a supply chain decision. Why craft techniques that machines do faster and cheaper are coming back anyway.', 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=800&q=60', 'fashion', false, false, 20),
        ('kalinova',  'Camera Traps and the New Science of Counting Tigers', 'camera-traps-counting-tigers', 'Researchers are replacing field surveys with sensors left overnight in the forest. The data is denser, cheaper, and sometimes harder to accept.', 'https://images.unsplash.com/photo-1474511320723-9a56873867b5?w=800&q=60', 'wildlife', false, true,  26),
        ('kalinova', 'A Migratory Bird Has Come Home to the Same Wetland', 'a-migratory-bird-has-come-home', 'Conservationists tracking a single bird across four countries found it had returned to the exact wetland where it was born. What that says about restored habitats.', 'https://images.unsplash.com/photo-1552728089-57bdde30beb3?w=800&q=60', 'wildlife', false, false, 32),
        ('kalinova', 'A Monsoon Diary: Twelve Days in Kerala by Train', 'a-monsoon-diary-twelve-days-in-kerala', 'The best way to understand a monsoon is to sit still in it. A slow journey through backwaters, hill stations, and one very unreliable timetable.', 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&q=60', 'travel', false, false,  38),
        ('kalinova',  'The Overnight Train That Still Connects the Country', 'the-overnight-train-that-connects', 'One route, one sleeper, and a line that still matters to the people who live along it. A photo essay on slow travel.', 'https://images.unsplash.com/photo-1474487548417-781cb71495f3?w=800&q=60', 'travel', false, true,  44),
        ('kalinova',   'What the Week''s Releases Say About Where Hindi Cinema Is Going', 'where-hindi-cinema-is-going', 'Three releases, three studios, one clear direction. A quick read on budgets, risk, and why the middle of the market is suddenly interesting again.', 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=800&q=60', 'latest-news', false, true, 4),
        ('kalinova',  'The Runway Just Met Its Supply Chain Problem Head On', 'runway-supply-chain-problem', 'Brands promised transparency and then shipped anyway. What happened next, and which designers actually kept the promise.', 'https://images.unsplash.com/photo-1469334031218-e382a71b716b?w=800&q=60', 'latest-news', false, false, 8)
) AS seed(username, title, slug, content, cover_image, category_slug, is_featured, is_trending, age_hours)
JOIN users u ON u.username = seed.username
JOIN categories c ON c.slug = seed.category_slug
ON CONFLICT (slug) DO NOTHING;
