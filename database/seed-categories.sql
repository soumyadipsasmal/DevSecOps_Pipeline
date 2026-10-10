-- Category banner images. Topics with their own photo library use a real image
-- from /assets/topics/<slug>/; the rest fall back to the shared brand card so
-- every category landing page still shows a banner. The DO UPDATE backfills
-- image on databases seeded before the column existed, without overwriting a
-- banner an admin set later.
INSERT INTO categories (name, slug, description, image, display_order)
VALUES
    ('Bollywood',   'bollywood',   'Indian cinema, from blockbuster releases to intimate character studies.', '/assets/topics/bollywood/01.jpg', 1),
    ('Tollywood',   'tollywood',   'Telugu and southern Indian film, and the voices reshaping it.',     '/assets/topics/tollywood/01.jpg', 2),
    ('Fashion',     'fashion',     'Design, craft, and the people rethinking how clothes get made.',    '/assets/topics/fashion/01.jpg',    3),
    ('Latest News', 'latest-news', 'What changed today, and what it means for the week ahead.',        '/assets/topics/latest-news/01.jpg', 4),
    ('Wildlife',    'wildlife',    'Animals, habitats, and the science of keeping them.',             '/assets/topics/wildlife/01.jpg',   5),
    ('Travel',      'travel',      'Slow journeys, long trains, and places worth the flight.',         '/assets/topics/travel/01.jpg',     6),
    ('Lifestyle',   'lifestyle',  'Style, wellness, food, and everyday living ideas.',               '/assets/og-image.png',             7),
    ('Kids',        'kids',       'Stories, activities, and family-friendly content.',               '/assets/og-image.png',             8),
    ('Food & Recipes', 'food-recipes', 'Recipes, regional kitchens, and the stories behind a good meal.', '/assets/og-image.png',         9),
    ('Sports',      'sports',     'Matches, athletes, and the rivalries that keep us watching.',      '/assets/og-image.png',            10),
    ('Education',   'education',  'Study guidance, exams, and learning resources for every stage.',  '/assets/og-image.png',            11),
    ('Digital & Technology', 'digital-technology', 'AI, apps, gadgets, and how technology reshapes daily life.', '/assets/og-image.png', 12),
    ('Cars & Bikes', 'cars-bikes', 'New launches, road tests, and keeping your ride on the road.',    '/assets/og-image.png',            13),
    ('History & Facts', 'history-facts', 'Indian history, historical places, and facts worth knowing.', '/assets/og-image.png',          14)
ON CONFLICT (slug) DO UPDATE
    SET image = EXCLUDED.image
    WHERE categories.image IS NULL;
