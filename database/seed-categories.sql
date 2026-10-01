INSERT INTO categories (name, slug, description, display_order)
VALUES
    ('Bollywood',   'bollywood',   'Indian cinema, from blockbuster releases to intimate character studies.', 1),
    ('Tollywood',   'tollywood',   'Telugu and southern Indian film, and the voices reshaping it.',     2),
    ('Fashion',     'fashion',     'Design, craft, and the people rethinking how clothes get made.',    3),
    ('Latest News', 'latest-news', 'What changed today, and what it means for the week ahead.',        4),
    ('Wildlife',    'wildlife',    'Animals, habitats, and the science of keeping them.',             5),
    ('Travel',      'travel',      'Slow journeys, long trains, and places worth the flight.',         6)
ON CONFLICT (slug) DO NOTHING;
