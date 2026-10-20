// Real brands, companies, products, investors and public figures that must never come out
// of a content generator (startup names, billboard copy) or appear in authored content.
//
// Three lists, because they need different matching:
//  - BRANDS: distinctive names. Blocked as a whole name, as a substring of a generated name,
//    within one edit of a generated name or word ("Anthropik"), and as a whole word in prose.
//  - GENERIC_BRANDS: brands that are also ordinary English words (Apple, Square, Slack). Blocked
//    when a generated name or one of its words IS the brand; never scanned in prose, where
//    "a square block" is just English.
//  - PEOPLE / SURNAMES: real public figures. Caricatures get invented names; a real name never
//    appears in content and never comes out of the name generator.
// Generated names also pass offensiveNameReason (bottom of file).
//
// The list is deliberately broad: blocking a harmless name costs nothing (the generator draws
// another), letting a real one through is the failure this file exists to prevent.

export const BRANDS: readonly string[] = [
  // AI labs, models and assistants
  "OpenAI", "ChatGPT", "GPT", "DALL-E", "Sora", "Anthropic", "Claude", "Gemini", "DeepMind", "Copilot",
  "Cortana", "Alexa", "Siri", "Llama", "LlamaIndex", "Mistral", "Mixtral", "Grok", "xAI", "Perplexity",
  "Midjourney", "Stable Diffusion", "Stability AI", "Pika Labs", "Suno", "Udio", "ElevenLabs", "Character.ai",
  "Replika", "Inflection AI", "Cohere", "AI21", "Hugging Face", "Scale AI", "Databricks",
  "Snowflake", "Pinecone", "Weaviate", "LangChain", "Jasper AI", "Copy.ai", "Grammarly", "Glean", "Hebbia",
  "Anysphere", "Replit", "Codeium", "Windsurf", "Cognition Labs", "Tabnine", "Sourcegraph",
  "Adept AI", "Rabbit R1", "Magic Leap", "Black Forest Labs", "Runway ML", "Synthesia", "HeyGen",
  "Otter.ai", "Clearview", "Palantir", "Anduril", "Shield AI", "Neuralink", "OpenRouter",
  "Groq", "Cerebras", "SambaNova", "Graphcore", "Together AI", "Fireworks AI", "Modal Labs", "Baseten",
  "Weights & Biases", "Kaggle", "Linux", "Ubuntu", "Debian", "Red Hat", "Unix", "DeepSeek", "Qwen", "Baidu", "Ernie Bot", "Moonshot AI", "Zhipu",
  // Big tech and their products
  "Google", "Alphabet", "YouTube", "Gmail", "Chromebook", "Pixel Phone", "Waymo", "Verily",
  "Facebook", "Instagram", "WhatsApp", "Oculus", "Microsoft", "Xbox", "LinkedIn",
  "Azure", "Bing", "PowerPoint", "iPhone", "iPad", "MacBook", "iCloud", "AirPods", "Vision Pro",
  "AWS", "Kindle", "Zoox", "Whole Foods", "Netflix", "Nvidia", "CUDA", "GeForce", "Tesla", "Cybertruck",
  "SpaceX", "Starlink", "Twitter", "Tweet", "Uber", "Lyft", "Airbnb", "DoorDash", "Instacart", "Postmates",
  "Grubhub", "Gopuff", "Yelp", "Nextdoor", "Pinterest", "Reddit", "Snapchat", "TikTok", "ByteDance",
  "Tinder", "Bumble", "Spotify", "SoundCloud", "Twitch", "Roblox", "Fortnite", "Nintendo", "PlayStation",
  "Samsung", "Huawei", "Xiaomi", "OnePlus", "Lenovo", "Qualcomm", "Broadcom", "TSMC", "Micron", "Cisco",
  "IBM", "SAP", "Workday", "ServiceNow", "Adobe", "Photoshop", "Autodesk", "Salesforce", "Tableau",
  "HubSpot", "Zendesk", "Intercom", "Twilio", "SendGrid", "Mailchimp", "Okta", "Cloudflare", "Akamai",
  "Fastly", "DigitalOcean", "Heroku", "Vercel", "Netlify", "Supabase", "Firebase", "MongoDB", "Redis",
  "Splunk", "Datadog", "PagerDuty", "New Relic", "GitHub", "GitLab", "Bitbucket",
  "Atlassian", "Jira", "Confluence", "Trello", "Asana", "ClickUp", "Airtable", "Zapier", "Retool", "Figma",
  "Canva", "Calendly", "Dropbox", "DocuSign", "Evernote", "Todoist", "Superhuman", "Webflow", "Squarespace",
  "Wix", "WordPress", "Shopify", "Etsy", "eBay", "Craigslist", "Wikipedia", "Mozilla", "Firefox", "Tumblr",
  "Flickr", "Substack", "Patreon", "Kickstarter", "Indiegogo", "Product Hunt", "Hacker News", "Quora",
  "Duolingo", "Peloton", "Fitbit", "GoPro", "Sonos", "Roku", "Hulu", "Disney", "Pixar", "Lucasfilm",
  "Boston Dynamics", "Unitree", "Kiwibot", "Starship Technologies", "Serve Robotics", "Nuro", "Motional",
  "Pony.ai", "WeRide", "Aurora Innovation", "Argo AI", "Cruise LLC", "Skydio", "Zipline", "Lime Scooter",
  // Money, fintech and crypto
  "Stripe", "Plaid", "Brex", "Rippling", "Gusto", "Deel", "Carta", "AngelList", "Robinhood", "Coinbase",
  "Binance", "PayPal", "Venmo", "Cash App", "Affirm", "Klarna", "SoFi", "Revolut", "Mastercard",
  "American Express", "Amex", "Wells Fargo", "Bank of America", "Goldman Sachs", "Morgan Stanley",
  "Bitcoin", "Ethereum", "Dogecoin", "Solana", "Tether", "FTX", "OpenSea", "Kalshi", "Polymarket",
  // Famous flameouts (still trademarks, still real)
  "Theranos", "Juicero", "WeWork", "Quibi", "Fyre",
  // Accelerators and venture firms
  "Y Combinator", "Techstars", "500 Startups", "500 Global", "Andreessen Horowitz", "a16z",
  "Sequoia", "Greylock", "Kleiner Perkins", "Lightspeed", "Founders Fund", "Khosla Ventures",
  "General Catalyst", "Index Ventures", "Tiger Global", "SoftBank", "Thrive Capital", "Insight Partners",
  "Bessemer", "Initialized Capital", "SV Angel", "First Round Capital", "Union Square Ventures",
  "Lux Capital", "Coatue", "Accel Partners", "Benchmark Capital", "Felicis", "Redpoint", "Battery Ventures",
  "Ribbit Capital", "Pear VC", "South Park Commons", "On Deck",
  // Consumer giants that show up on SF streets
  "Starbucks", "Blue Bottle", "Philz", "Peet's", "Safeway", "Trader Joe's", "Walgreens", "CVS",
  "Walmart", "Costco", "McDonald's", "Chipotle", "Sweetgreen", "In-N-Out", "Coca-Cola", "Pepsi",
  "Red Bull", "Nike", "Adidas", "Patagonia", "Allbirds", "Lululemon", "Levi's", "Ghirardelli", "Boudin",
  "Tartine", "Salesforce Tower",
  // Developer tools, languages, frameworks and infrastructure
  "TensorFlow", "PyTorch", "Keras", "scikit-learn", "NumPy", "SciPy", "Jupyter", "Colab", "Docker", "Kubernetes",
  "Terraform", "HashiCorp", "Ansible", "Jenkins", "CircleCI", "Travis CI", "Buildkite", "Kafka", "RabbitMQ",
  "Elasticsearch", "Kibana", "Grafana", "Nginx", "Node.js", "Deno", "pnpm", "Webpack", "Vite", "ESLint",
  "TypeScript", "JavaScript", "Kotlin", "Golang", "Vue.js", "Svelte", "Next.js", "Nuxt", "Ember.js", "jQuery",
  "Three.js", "Godot", "Unreal Engine", "Houdini", "PostgreSQL", "Postgres", "MySQL", "SQLite", "MariaDB",
  "CockroachDB", "Neo4j", "DynamoDB", "BigQuery", "Redshift", "Firestore", "PlanetScale", "Hasura", "Appwrite",
  "Fly.io", "Linode", "Vultr", "Hetzner", "Backblaze", "Mailgun", "Auth0", "OneLogin", "LastPass", "1Password",
  "Bitwarden", "Dashlane", "NordVPN", "ExpressVPN", "Tailscale", "WireGuard", "Cloudinary", "Contentful",
  "Strapi", "Algolia", "Typesense", "Mixpanel", "PostHog", "FullStory", "Hotjar", "LogRocket", "Dynatrace",
  "Snyk", "SonarQube", "Dependabot", "CodeSandbox", "StackBlitz", "CodePen", "Stack Overflow", "LeetCode",
  "HackerRank", "Vectorworks", "Parrot OS", "CableLabs", "Raspberry Pi", "Arduino", "Adafruit", "SparkFun",
  "Miro", "Raycast", "Typeform", "Krisp", "PromptBase", "Prompt flow", "PromptLayer", "PromptLoop", "WidgetKit",
  "Gadget Flow", "Gadget Lab", "Hushly", "Embedly", "Velora", "Tokenly", "WidgetBot", "Minix", "Xenix", "Badgr", "Embr Labs",
  "Nymox", "TerraVia", "Katara",
  // More AI companies, models, robots and robotaxis
  "Ollama", "LangSmith", "LangGraph", "Langfuse", "CrewAI", "AutoGPT", "You.com", "Phind", "Kagi", "Neeva",
  "DuckDuckGo", "Decagon", "Beautiful.ai", "Descript", "Opus Clip", "CapCut", "Luma AI", "Kling AI", "Hailuo",
  "Ideogram", "Leonardo.ai", "Krea", "Recraft", "Freepik", "Shutterstock", "Getty Images", "Unsplash",
  "Aleph Alpha", "Sakana AI", "Nous Research", "EleutherAI", "LAION", "LM Studio", "vLLM", "Lambda Labs",
  "CoreWeave", "Nebius", "Vast.ai", "RunPod", "Arize", "Comet ML", "Genspark", "Thinking Machines",
  "Safe Superintelligence", "World Labs", "Physical Intelligence", "Skild AI", "Apptronik", "Sanctuary AI",
  "Mujin", "Bear Robotics", "Miso Robotics", "Wayve", "Mobileye", "Comma.ai", "Kodiak Robotics", "TuSimple",
  "Gatik", "Einride", "May Mobility", "Knightscope", "Cobalt Robotics", "Savioke", "Pudu Robotics", "Keenon",
  "Roborock", "Ecovacs", "Roomba", "iRobot", "ANYbotics", "Ghost Robotics", "Locus Robotics", "Cartken",
  "Refraction AI", "Matternet", "Flytrex", "DroneUp", "Tensor Auto",
  // Robots and cars from film and TV (our robots are original designs)
  "WALL-E", "R2-D2", "C-3PO", "BB-8", "K-2SO", "Johnny 5", "Baymax", "Robby the Robot", "HAL 9000",
  "Optimus Prime", "Megatron", "Robocop", "Ultron", "Astro Boy", "Gundam", "Voltron", "Iron Giant", "Mega Man",
  "Dalek", "Cylon", "Skynet", "KITT", "Batmobile", "Lightning McQueen", "Ecto-1", "Chappie",
  // More internet, games, social and consumer apps
  "Yahoo", "AOL", "MSN", "Hotmail", "Skype", "Minecraft", "Mojang", "Activision", "Bethesda", "Ubisoft",
  "Electronic Arts", "Riot Games", "League of Legends", "Valorant", "Pokemon", "Sega", "Capcom", "Konami",
  "Atari", "Rockstar Games", "Grand Theft Auto", "Zelda", "Super Mario", "WeChat", "Weibo", "Tencent", "Alibaba",
  "AliExpress", "Taobao", "Temu", "Shein", "Meituan", "Pinduoduo", "Douyin", "Kuaishou", "Kakao", "Naver",
  "Rakuten", "Mercari", "Gojek", "Shopee", "Lazada", "Flipkart", "Paytm", "Swiggy", "Zomato", "Infosys", "Wipro",
  "Accenture", "Deloitte", "McKinsey", "KPMG", "Gartner", "Myspace", "Friendster", "BeReal", "Lemon8", "Bluesky",
  "Truth Social", "Parler", "OnlyFans", "Goodreads", "Letterboxd", "Strava", "Oura", "Noom", "MyFitnessPal",
  "Garmin", "Withings", "Eight Sleep", "Raya", "Grindr", "OkCupid", "Match.com", "Coffee Meets Bagel", "Feeld",
  "Zocdoc", "One Medical", "Carbon Health", "23andMe", "SurveyMonkey", "Qualtrics", "Jotform", "Shipt", "Getir",
  "Getaround", "Turo", "Zipcar", "Bay Wheels", "Ford GoBike", "Zillow", "Redfin", "Trulia", "Opendoor", "Offerpad",
  "Realtor.com", "StreetEasy", "Zumper", "PadMapper", "Rent the Runway", "Stitch Fix", "ThredUp", "Poshmark",
  "Depop", "Grailed", "StockX", "Vinted", "Wayfair", "IKEA", "Home Depot", "Lowe's", "Sephora", "Ulta", "Glossier",
  "Warby Parker", "Brooklinen", "Bombas", "Everlane", "Outdoor Voices", "Gymshark", "Vuori", "Rothy's", "Hoka",
  "Salomon", "Arc'teryx", "North Face", "REI", "Hypebeast", "Off-White", "Balenciaga", "Gucci", "Prada",
  "Louis Vuitton", "Hermes", "Chanel", "Rolex", "Casio", "Swatch", "Uniqlo", "Zara", "H&M", "Old Navy",
  "Banana Republic", "J.Crew", "Madewell", "Abercrombie", "Hollister", "Under Armour", "Reebok", "Birkenstock",
  "Dr. Martens", "Timberland", "UGG", "Skechers", "Asics", "Saucony", "Mizuno", "Tripadvisor", "Expedia",
  "Booking.com", "Priceline", "Vrbo", "Hipcamp", "OpenTable", "Resy", "ChowNow", "SpotHero", "ParkMobile",
  "PayByPhone", "Waze", "Mapbox", "Foursquare", "Niantic", "AllTrails", "Komoot", "Linktree", "Carrd", "Gumroad",
  "Teachable", "Thinkific", "Kajabi", "Eventbrite", "Upwork", "Fiverr", "TaskRabbit", "Angi", "Care.com",
  "Glassdoor", "ZipRecruiter", "Trustpilot", "Capterra", "Coursera", "Udemy", "Udacity", "Khan Academy", "edX",
  "Chegg", "Quizlet", "Brainly", "Kahoot", "Vimeo", "Netscape", "Napster", "LimeWire", "BitTorrent", "Winamp",
  "ICQ", "Lycos", "AltaVista", "Ask Jeeves", "GeoCities", "StumbleUpon", "Digg", "Orkut", "Picasa", "LiveJournal",
  "Xanga", "Yik Yak", "Pets.com", "Webvan", "Kozmo", "Solyndra", "Jawbone", "Jibo", "Anki", "Cozmo", "Aibo",
  "Furby", "Tamagotchi", "Klaviyo", "Beehiiv", "ConvertKit", "Hootsuite", "Sprout Social",
  "Smartsheet", "Wrike", "Lucidchart", "Excalidraw", "tldraw", "Prezi", "InVision", "Softr", "Adalo", "IFTTT",
  "n8n", "Pipedream", "Cal.com", "Vidyard", "Salesloft", "ZoomInfo", "Clearbit", "Lusha", "Lemlist", "Missive",
  "Freshdesk", "Freshworks", "Help Scout", "Gorgias", "Kustomer", "6sense", "Demandbase", "Optimizely",
  "LaunchDarkly", "Statsig", "Benchling", "Flexport", "Verkada", "Rubrik", "Confluent", "Zynga",
  "Bungie", "Ginkgo Bioworks", "Altos Labs", "Exploratorium",
  // Cars, bikes, gadgets and household names
  "Rivian", "Lucid Motors", "Polestar", "Fisker", "Faraday Future", "Canoo", "Aptera", "Chevrolet", "Chevy",
  "General Motors", "GMC", "Cadillac", "Buick", "Chrysler", "Jeep", "Toyota", "Lexus", "Honda", "Acura", "Nissan",
  "Infiniti", "Mazda", "Subaru", "Mitsubishi", "Hyundai", "Kia", "Volkswagen", "Audi", "Porsche", "BMW",
  "Mercedes-Benz", "Mercedes", "Volvo", "Land Rover", "Ferrari", "Lamborghini", "Maserati", "Bentley",
  "Rolls-Royce", "Bugatti", "McLaren", "Fiat", "Alfa Romeo", "Peugeot", "Renault", "Citroen", "Skoda", "BYD",
  "XPeng", "Geely", "Zeekr", "Harley-Davidson", "Ducati", "Vespa", "Segway", "Onewheel", "VanMoof",
  "Rad Power Bikes", "Cannondale", "DeLorean", "Ford", "Bose", "Sennheiser", "Logitech", "Razer", "Alienware",
  "Asus", "Acer", "Toshiba", "Panasonic", "Philips", "Nikon", "Fujifilm", "Kodak", "Polaroid", "Leica", "DJI",
  "Insta360", "TomTom", "Arlo", "Wyze", "Eufy", "Anker", "Dyson", "Keurig", "Nespresso", "Vitamix",
  "Instant Pot", "KitchenAid", "Traeger", "Hydro Flask", "Owala", "Brita", "SodaStream", "Juul", "Ray-Ban",
  "Oakley", "HoloLens", "Steam Deck", "Game Boy", "Snapdragon", "MediaTek", "Marvell", "Texas Instruments",
  "Seagate", "SanDisk", "Western Digital", "ThinkPad", "Chromecast", "Audible", "IMDb", "Zappos", "Eero",
  "Velcro", "Xerox", "Kleenex", "Post-it", "Band-Aid", "Jacuzzi", "Frisbee", "Popsicle", "Sharpie", "Zamboni",
  "Taser", "Styrofoam", "Lego", "Hasbro", "Mattel", "Barbie", "Nerf", "Play-Doh", "Hewlett-Packard",
  "Sun Microsystems", "Fairchild Semiconductor", "AT&T", "Verizon", "T-Mobile", "Comcast", "Xfinity",
  "Monkeybrains", "Google Fiber", "Mint Mobile", "Vodafone", "Telstra", "Nokia", "Ericsson", "Motorola",
  "Handspring", "Nextel", "HTC", "ZTE",
  // More money, fintech and crypto
  "Navan", "TripActions", "Expensify", "Bill.com", "QuickBooks", "Intuit", "TurboTax", "Credit Karma",
  "NerdWallet", "Betterment", "Wealthfront", "Acorns", "Webull", "eToro", "E*Trade", "Charles Schwab", "Schwab",
  "BlackRock", "Jane Street", "Two Sigma", "Bridgewater", "JPMorgan", "Citibank", "Citigroup", "HSBC", "Barclays",
  "Deutsche Bank", "Capital One", "Marqeta", "Adyen", "Checkout.com", "Braintree", "BigCommerce", "WooCommerce",
  "Magento", "Lemon Squeezy", "Chargebee", "Recurly", "Zuora", "Avalara", "Justworks", "TriNet", "ADP", "Paychex",
  "Paylocity", "BambooHR", "Workable", "Culture Amp", "15Five", "Leapsome", "Wefunder", "StartEngine",
  "SeedInvest", "GoFundMe", "Zelle", "Monzo", "N26", "Starling Bank", "Nubank", "Afterpay", "Sezzle",
  "LendingClub", "Kabbage", "Bluevine", "Bitfinex", "Bitstamp", "Crypto.com", "Trezor", "MetaMask", "Uniswap",
  "Aave", "Chainlink", "Cardano", "XRP", "Litecoin", "Monero", "Zcash", "Shiba Inu", "Worldcoin", "Filecoin",
  "Arweave", "Bored Ape", "CryptoPunks", "Axie Infinity", "Arbitrum", "Pump.fun", "Chainalysis", "Moody's",
  // More venture firms and accelerators
  "Forerunner Ventures", "Spark Capital", "General Atlantic", "KKR", "Blackstone", "Mayfield Fund",
  "New Enterprise Associates", "Matrix Partners", "Emergence Capital", "Craft Ventures", "8VC", "Social Capital",
  "Lowercase Capital", "Sutter Hill", "IVP", "DST Global", "Greenoaks", "Iconiq", "Dragoneer", "Hustle Fund",
  "BoxGroup", "Slow Ventures", "Village Global", "Soma Capital", "Entrepreneur First", "Plug and Play",
  "Alchemist Accelerator", "Founder Institute", "HF0", "AGI House", "Cerebral Valley",
  // More food, drink and shops, many of them on SF streets
  "Sightglass", "Ritual Coffee", "Four Barrel", "Verve Coffee", "Equator Coffees", "Dunkin", "Tim Hortons",
  "Dutch Bros", "Joe & the Juice", "Pret a Manger", "Le Pain Quotidien", "Panera", "Jersey Mike's",
  "Jimmy John's", "Potbelly", "Taco Bell", "Del Taco", "El Farolito", "La Taqueria", "Bi-Rite",
  "Mitchell's Ice Cream", "Humphry Slocombe", "Salt & Straw", "Ben & Jerry's", "Haagen-Dazs", "Baskin-Robbins",
  "Dairy Queen", "Krispy Kreme", "Boba Guys", "Gong Cha", "Mendocino Farms", "Shake Shack", "Super Duper Burgers",
  "Burger King", "Wendy's", "Popeyes", "KFC", "Chick-fil-A", "Wingstop", "Domino's", "Pizza Hut", "Papa John's",
  "Little Caesars", "Round Table Pizza", "Zuni Cafe", "Swan Oyster Depot", "House of Prime Rib", "Waffle House",
  "Anchor Brewing", "Anchor Steam", "Lagunitas", "Sierra Nevada", "Budweiser", "Bud Light", "Coors", "Heineken",
  "Guinness", "Stella Artois", "Modelo", "Pabst", "Liquid Death", "Olipop", "Poppi", "Athletic Greens", "AG1",
  "Huel", "Soylent", "Saran", "Impossible Foods", "Beyond Meat", "Oatly", "Califia", "Clif Bar", "RXBar", "Health-Ade",
  "Dandelion Chocolate", "Swensen's", "Rainbow Grocery", "Gus's Market", "Mollie Stone's", "Williams-Sonoma",
  "Clorox", "Chevron", "PG&E",
  // Media
  "HBO", "Crunchyroll", "Deezer", "SiriusXM", "iHeartRadio", "NPR", "KQED", "New York Times",
  "Wall Street Journal", "Bloomberg", "Reuters", "TechCrunch", "Engadget", "Gizmodo", "Mashable", "Axios",
  "Politico", "Semafor", "Business Insider", "Forbes", "BuzzFeed", "HuffPost", "SF Chronicle", "SFGate",
  "SF Standard", "Hoodline", "Thrillist", "Stratechery", "Slashdot", "Ars Technica", "MacRumors",
];

export const GENERIC_BRANDS: readonly string[] = [
  "Apple", "Amazon", "Meta", "X", "Square", "Block", "Box", "Slack", "Notion", "Linear", "Zoom", "Signal",
  "Snap", "Lime", "Bird", "Ramp", "Scale", "Writer", "Index", "Benchmark", "Accel", "Pi", "Rabbit", "Cursor",
  "Runway", "Jasper", "Hinge", "Discord", "Oracle", "Shell", "Dell", "HP", "Intel", "AMD", "Arm", "Sony",
  "Oppo", "Nest", "Ring", "Wing", "Chrome", "Pixel", "Bard", "Codex", "Devin", "Bolt", "Cognition", "Figure",
  "Agility", "Digit", "Spot", "Optimus", "Cruise", "Aurora", "Starship", "Coco", "Serve", "Mercury", "Chime",
  "Wise", "Kraken", "Medium", "Loom", "Monday", "Teams", "Webex", "Threads", "Pebble", "Tidal", "Clover",
  "Pandora", "Steam", "Valve", "Epic", "Unity", "Watson", "Lumen", "Flux", "Kick", "Gong", "Otter", "Modal",
  "Together", "Fireworks", "Sentry", "Elastic", "Mint", "Robin", "Granola", "Harvey", "Humane", "Magic",
  "Replica", "Character", "Inflection", "Adept", "Pika", "Messenger", "Windows", "Outlook", "Office", "Edge",
  "Surface", "Echo", "Prime", "Safari", "Maps", "Wallet", "Venture", "Thrive", "Insight", "Lux", "Android",
  "Fireflies", "Chase", "Visa", "Target", "Lovable", "Clubhouse",
  // Dictionary-word tech brands that the name generator once spelled ("Lattice HQ", "Drift AI").
  "Lattice", "Drift", "Juniper", "Comet", "Glide", "Pylon", "Kernel", "Ledger", "Dune", "Sierra", "Gamma", "Arc",
  "Warp", "Fable", "Wren", "Kiln", "Hatch", "Orbit", "Prism", "Vapor", "Tally", "Sonder", "Ember", "Quill",
  "Nimbus", "Fennel", "Grove", "Burrow", "Cove", "Sable", "Lumber", "Thistle", "Rook", "Marble", "Parrot",
  "Tensor", "Vector", "Calm", "Brave", "Lucid", "Compass", "Anchor", "Harbor", "Flow",
  // More brands that are also ordinary words
  "Telegram", "Obsidian", "Amplitude", "Headspace", "Pandas", "Anaconda", "Helm", "Puppet", "Chef", "Postman",
  "Swagger", "Apache", "Tomcat", "Bun", "Yarn", "Rollup", "Babel", "Prettier", "Python", "Java", "Rust", "Swift",
  "React", "Angular", "Remix", "Gatsby", "Bootstrap", "Tailwind", "Unreal", "Blender", "Maya", "Neon", "Prisma",
  "Drizzle", "Render", "Railway", "Wasabi", "Postmark", "Resend", "Clerk", "Sanity", "Ghost", "Segment", "Heap",
  "Honeycomb", "Renovate", "Glitch", "Canvas", "Blackboard", "Continue", "Zed", "Alfred", "Dia", "Typeface",
  "Tome", "Captions", "Riverside", "Poe", "Replicate", "Neptune", "Manus", "Lindy", "Poolside", "Augment",
  "Factory", "Dexterity", "Atlas", "Imbue", "Covariant", "MiniMax", "Jarvis", "Bender", "Terminator",
  "Transformers", "Marvin", "Line", "Grab", "Gab", "Rumble", "Cameo", "Whoop", "Polar", "Forward", "Oscar",
  "Ancestry", "Doodle", "Caviar", "Seamless", "Favor", "Spin", "Jump", "Scoot", "Revel", "Clipper", "Dodge", "Ram",
  "Genesis", "Mini", "Jaguar", "Seat", "Smart", "Specialized", "Trek", "Beats", "Corsair", "Sharp", "Canon",
  "Weber", "Yeti", "Stanley", "Friend", "Limitless", "Pilot", "Bench", "Puzzle", "Stash", "Fidelity", "Vanguard",
  "Citadel", "Renaissance", "Discover", "Toast", "Paddle", "Remote", "Greenhouse", "Lever", "Pulley", "Republic",
  "Prosper", "Relay", "Phantom", "Polygon", "Avalanche", "Ripple", "Optimism", "Blast", "Manifold", "Basecamp",
  "Height", "Shortcut", "Coda", "Quip", "Mural", "Whimsical", "Pitch", "Keynote", "Sketch", "Framer", "Bubble",
  "Outreach", "Apollo", "Clay", "Hunter", "Instantly", "Spark", "Front", "Shortwave", "Kit", "Buffer", "Circle",
  "Discourse", "Gather", "Tandem", "Tuple", "Fathom", "Grain", "Qualified", "Monster", "Thumbtack", "Rover", "Wag",
  "Tock", "Swarm", "Kayak", "Hopper", "Casper", "Purple", "Parachute", "Reformation", "Columbia", "Supreme",
  "Omega", "Tiffany", "Gap", "Puma", "Converse", "Vans", "Crocs", "Brooks", "Cava", "Subway", "Corona", "Celsius",
  "Kind", "Max", "Peacock", "Wired", "Fortune", "Vice", "Pitchfork", "Conviction", "Neo", "Homebrew", "Haystack",
  "Pioneer", "Launch", "Samsara", "Sprint", "Spectrum", "Cox", "Sonic", "Orange", "BlackBerry", "Palm",
  "Blizzard", "Halo", "Rockstar", "Shark", "Excite", "Delicious", "Vine", "Periscope", "Blogger", "Path", "Secret",
  "Color", "Luna", "Mastodon", "Indeed", "Overwatch", "Best Buy", "New Balance", "Call of Duty", "Five Guys",
  "Jack in the Box", "Showtime", "Paramount", "Eater", "Platformer", "Mission Local", "The Verge",
  "Fast Company", "Rolling Stone", "Divvy", "Upstart", "Floodgate", "Antler", "Altimeter", "Dandelion",
  "Lemonade", "Convoy", "Leonardo", "Verve",
];

export const PEOPLE: readonly string[] = [
  "Paul Graham", "Jessica Livingston", "Garry Tan", "Michael Seibel", "Sam Altman", "Elon Musk",
  "Mark Zuckerberg", "Jeff Bezos", "Marc Andreessen", "Ben Horowitz", "Peter Thiel", "Reid Hoffman",
  "Jensen Huang", "Lisa Su", "Satya Nadella", "Sundar Pichai", "Tim Cook", "Larry Page", "Sergey Brin",
  "Bill Gates", "Steve Jobs", "Steve Wozniak", "Jack Dorsey", "Brian Chesky", "Travis Kalanick",
  "Dara Khosrowshahi", "Marc Benioff", "Naval Ravikant", "Balaji Srinivasan", "Dario Amodei",
  "Daniela Amodei", "Demis Hassabis", "Mustafa Suleyman", "Ilya Sutskever", "Greg Brockman", "Mira Murati",
  "Andrej Karpathy", "Yann LeCun", "Geoffrey Hinton", "Fei-Fei Li", "Andrew Ng", "Arthur Mensch",
  "Aravind Srinivas", "Alexandr Wang", "Chamath Palihapitiya", "David Sacks", "Jason Calacanis",
  "Keith Rabois", "Vinod Khosla", "Masayoshi Son", "Patrick Collison", "John Collison", "Drew Houston",
  "Evan Spiegel", "Kevin Systrom", "Sheryl Sandberg", "Susan Wojcicki", "Marissa Mayer",
  "Elizabeth Holmes", "Sam Bankman-Fried", "Adam Neumann", "Kara Swisher", "Steve Ballmer",
  "Larry Ellison", "Tony Xu", "Apoorva Mehta", "Logan Green", "Ev Williams", "Dick Costolo",
  "Parag Agrawal", "Linda Yaccarino", "Gavin Newsom", "London Breed", "Daniel Lurie", "Nancy Pelosi",
  "Scott Wiener", "Aaron Peskin", "Ron Conway", "Mike Moritz", "Doug Leone", "Roelof Botha",
  "Bill Gurley", "Fred Wilson", "Brad Feld", "Paul Buchheit", "Harj Taggar", "Dalton Caldwell",
  "Jony Ive", "Vitalik Buterin", "Changpeng Zhao", "Brian Armstrong", "Alexis Ohanian", "Steve Huffman",
  "Jack Ma", "Daniel Ek", "Reed Hastings", "Tobi Lutke", "Stewart Butterfield", "Eric Yuan", "Dylan Field",
  "Ivan Zhao", "Guillermo Rauch", "Elad Gil", "Sarah Guo", "Nat Friedman", "Daniel Gross", "Lex Fridman",
  "Joe Rogan", "Pieter Levels", "Paul Allen", "Eric Schmidt", "Jeff Dean", "Noam Shazeer", "Mark Cuban",
  "Gary Vaynerchuk", "Tim Ferriss", "Lenny Rachitsky", "Adam D'Angelo", "Emmett Shear", "Bret Taylor",
  "Mike Krieger", "Ali Ghodsi", "Frank Slootman", "Andy Jassy", "Mark Pincus", "Chris Sacca", "Josh Kushner",
  "Brad Gerstner", "Mary Meeker", "Joe Lonsdale", "Alex Karp", "Palmer Luckey", "Bryan Johnson",
  "Ray Kurzweil", "Eliezer Yudkowsky", "Nick Bostrom", "Donald Trump", "Joe Biden", "Kamala Harris",
  "Ro Khanna", "Matt Mahan", "Kim Kardashian", "Taylor Swift", "MrBeast",
];

/** Surnames distinctive enough that a bare surname reads as the real person. */
export const SURNAMES: readonly string[] = [
  "Altman", "Musk", "Zuckerberg", "Bezos", "Andreessen", "Thiel", "Nadella", "Pichai", "Amodei",
  "Hassabis", "Dorsey", "Chesky", "Kalanick", "Benioff", "Ravikant", "Seibel", "Palihapitiya", "Calacanis",
  "Rabois", "Sutskever", "Brockman", "Murati", "Karpathy", "LeCun", "Hinton", "Suleyman", "Collison",
  "Systrom", "Sandberg", "Wojcicki", "Neumann", "Ballmer", "Khosrowshahi", "Wozniak", "Bankman",
  "Yaccarino", "Costolo", "Agrawal", "Newsom", "Pelosi", "Peskin", "Moritz", "Gurley", "Buchheit",
  "Livingston", "Huang", "Gates", "Jobs", "Brin", "Hoffman", "Horowitz", "Graham",
  "Buterin", "Ohanian", "Lutke", "Butterfield", "Fridman", "Shazeer", "Vaynerchuk", "Ferriss", "Rachitsky",
  "Ghodsi", "Slootman", "Jassy", "Pincus", "Kushner", "Gerstner", "Lonsdale", "Luckey", "Kurzweil", "Yudkowsky",
  "Bostrom", "Trump", "Biden", "Khanna", "Kardashian",
];

/** Lower-case, accents stripped, everything but a-z and 0-9 removed. */
export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

/** Words of a name or sentence, normalized, empty ones dropped. "kale.ai" -> ["kale", "ai"]. */
export function tokens(s: string): string[] {
  return s
    .split(/[\s.\-_/,:;!?'"()]+/)
    .map(normalize)
    .filter((t) => t.length > 0);
}

/** Levenshtein distance with an early exit once it exceeds `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] as number;
}

const N_BRANDS = BRANDS.map((b) => [b, normalize(b)] as const);
// Near-miss candidates bucketed by length, so a check only compares strings that are within one edit.
const NEAR_BY_LEN = new Map<number, Array<readonly [string, string]>>();
for (const e of N_BRANDS) {
  if (e[1].length < 5) continue;
  const list = NEAR_BY_LEN.get(e[1].length) ?? [];
  list.push(e);
  NEAR_BY_LEN.set(e[1].length, list);
}

/** True when a and b differ by at most one insertion, deletion or substitution. Linear time. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a.length < b.length) [a, b] = [b, a];
  const la = a.length;
  const lb = b.length;
  if (la - lb > 1) return false;
  let i = 0;
  while (i < lb && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i === lb) return true; // equal, or a has one extra trailing char
  // First mismatch at i: a substitution (same lengths) or a deletion from the longer a.
  const skip = la === lb ? 1 : 0;
  for (let k = i + 1; k < la; k++) if (a.charCodeAt(k) !== b.charCodeAt(k - 1 + skip)) return false;
  return true;
}

function nearMiss(s: string): string | null {
  for (let len = s.length - 1; len <= s.length + 1; len++) {
    for (const [label, b] of NEAR_BY_LEN.get(len) ?? []) if (withinOneEdit(s, b)) return label;
  }
  return null;
}
const N_GENERIC = GENERIC_BRANDS.map((b) => [b, normalize(b)] as const);
// Generic brands of 6+ letters are also near-missed ("Ledgr", "Junipr"); shorter ones would
// catch half the dictionary.
const N_GENERIC_NEAR = N_GENERIC.filter(([, b]) => b.length >= 6);
const N_PEOPLE = PEOPLE.map((p) => [p, normalize(p)] as const);
const N_SURNAMES = SURNAMES.map((p) => [p, normalize(p)] as const);

// The lists are indexed by normalized spelling, and a name is checked by looking up its own
// substrings, words and prefixes: a few dozen lookups instead of a scan of every entry. When
// several entries match, the one listed first wins, as a straight scan in list order would.
interface Entry {
  label: string;
  order: number;
}
function indexOf(list: ReadonlyArray<readonly [string, string]>): Map<string, Entry> {
  const m = new Map<string, Entry>();
  list.forEach(([label, norm], order) => {
    if (!m.has(norm)) m.set(norm, { label, order });
  });
  return m;
}
const BRAND_INDEX = indexOf(N_BRANDS);
const GENERIC_INDEX = indexOf(N_GENERIC);
const PEOPLE_INDEX = indexOf(N_PEOPLE);
const SURNAME_INDEX = indexOf(N_SURNAMES);

/** The earliest-listed entry whose spelling is one of `keys`. */
function firstHit(index: Map<string, Entry>, keys: Iterable<string>): Entry | null {
  let best: Entry | null = null;
  for (const k of keys) {
    const e = index.get(k);
    if (e && (best === null || e.order < best.order)) best = e;
  }
  return best;
}

/** Every substring of s with at least `min` characters. */
function substrings(s: string, min: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) for (let j = i + min; j <= s.length; j++) out.push(s.slice(i, j));
  return out;
}

/** Every prefix of each string with at least `min` characters. */
function prefixes(xs: readonly string[], min: number): string[] {
  const out: string[] = [];
  for (const x of xs) for (let j = min; j <= x.length; j++) out.push(x.slice(0, j));
  return out;
}

/** Of two hits, the earlier-listed one; on the same entry, `a` (the check made first). */
function earlier<T extends { e: Entry }>(a: T | null, b: T | null): T | null {
  if (a === null) return b;
  if (b === null) return a;
  return b.e.order < a.e.order ? b : a;
}
const hit = (e: Entry | null, why: string): { e: Entry; why: string } | null => (e ? { e, why } : null);

/**
 * Why a generated NAME is not allowed, or null if it is fine. Strict: a name is rejected when
 * it is, contains, or nearly spells a distinctive brand; when it, any of its words or CamelCase
 * parts is a generic brand, or a word starts with one; or when it contains a real person's
 * name or distinctive surname.
 */
export function blockedNameReason(name: string): string | null {
  const n = normalize(name);
  const words = tokens(name);
  if (n.length === 0) return "empty";
  const subs3 = substrings(n, 3);
  const brand = earlier(hit(firstHit(BRAND_INDEX, subs3), "contains brand"), hit(firstHit(BRAND_INDEX, [n, ...words]), "is brand"));
  if (brand) return `${brand.why} "${brand.e.label}"`;
  const whole = nearMiss(n);
  if (whole) return `near-miss of brand "${whole}"`;
  for (const w of words) {
    const near = nearMiss(w);
    if (near) return `word near-miss of brand "${near}"`;
  }
  // Generic brands: the name, a word or a CamelCase part IS the brand ("Lattice HQ", "JuniperOS"),
  // or a word starts with a brand of 5+ letters ("Cometly", "Vectorly").
  const generic = earlier(
    hit(firstHit(GENERIC_INDEX, [n, ...nameParts(name)]), "is brand"),
    hit(firstHit(GENERIC_INDEX, prefixes([n, ...words], 5)), "starts with brand"),
  );
  if (generic) return `${generic.why} "${generic.e.label}"`;
  const lens = new Set([n, ...words].map((x) => x.length));
  for (const [label, b] of N_GENERIC_NEAR) {
    if (!lens.has(b.length - 1) && !lens.has(b.length) && !lens.has(b.length + 1)) continue;
    if (withinOneEdit(n, b) || words.some((w) => withinOneEdit(w, b))) return `near-miss of brand "${label}"`;
  }
  const person = firstHit(PEOPLE_INDEX, subs3);
  if (person) return `contains person "${person.label}"`;
  const surname = earlier(hit(firstHit(SURNAME_INDEX, words), ""), hit(firstHit(SURNAME_INDEX, substrings(n, 5)), ""));
  if (surname) return `contains surname "${surname.e.label}"`;
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Prose matching: whole words, case-insensitive, punctuation inside the brand kept literal.
const ALWAYS_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [];

const WORD_PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ...BRANDS.map((b) => [`brand "${b}"`, b] as const),
  ...PEOPLE.map((p) => [`person "${p}"`, p] as const),
  ...SURNAMES.filter((s) => s.length >= 5 && !["Gates", "Jobs", "Graham", "Huang", "Hinton"].includes(s)).map(
    (s) => [`surname "${s}"`, s] as const,
  ),
];

/** Lower-case runs of letters and digits: the words a whole-word pattern can start on. */
function proseWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0);
}

// A whole-word match of "Hugging Face" can only start where the text has the word "hugging",
// so the patterns are indexed by their first word and a check runs only the few that can hit.
const PROSE_INDEX = new Map<string, Array<{ order: number; label: string; re: RegExp }>>();
WORD_PATTERNS.forEach(([label, phrase], order) => {
  const first = proseWords(phrase)[0];
  if (!first) throw new Error(`blocklist: "${phrase}" has no letters or digits`);
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(phrase)}($|[^A-Za-z0-9])`, "i");
  const list = PROSE_INDEX.get(first) ?? [];
  list.push({ order, label, re });
  PROSE_INDEX.set(first, list);
});

/**
 * Why a piece of PROSE (billboard copy, dialogue, descriptions) is not allowed, or null.
 * Looser than names: generic-word brands and common surnames are ordinary English here.
 */
export function blockedProseReason(text: string): string | null {
  for (const [label, re] of ALWAYS_PATTERNS) if (re.test(text)) return `mentions ${label}`;
  const hits: Array<{ order: number; label: string; re: RegExp }> = [];
  for (const w of new Set(proseWords(text))) hits.push(...(PROSE_INDEX.get(w) ?? []));
  hits.sort((a, b) => a.order - b.order);
  for (const h of hits) if (h.re.test(text)) return `mentions ${h.label}`;
  return null;
}

// Words a generated name must never spell, even by accident ("Sa" + "ta" + "n" = "Satan"):
// profanity, slurs, hate, sex, hard drugs, violence and religious figures. A startup name
// can end up on a billboard or as the player's company, so the bar is "would this embarrass
// anyone on a bus", not "is it a swear word". Two lists, because "ass" sits inside "Brass"
// and "hell" inside "Shell":
//  - OFFENSIVE_STEMS: rejected anywhere inside the normalized name.
//  - OFFENSIVE_WORDS: rejected only as a whole word or CamelCase part ("Hell AI", "KaleHell").
export const OFFENSIVE_STEMS: readonly string[] = [
  "fuck", "shit", "cunt", "bitch", "whore", "slut", "nigg", "fagg", "faggot", "retard", "tranny", "kike",
  "wetback", "nazi", "hitler", "swastika", "satan", "lucifer", "porn", "rapist", "penis", "vagina", "dildo",
  "cocaine", "heroin", "fentanyl", "opioid", "opium", "xanax", "adderall", "ketamine", "murder", "suicide",
  "terroris", "jihad",
];

export const OFFENSIVE_WORDS: readonly string[] = [
  "ass", "arse", "hell", "damn", "crap", "piss", "tit", "tits", "boob", "boobs", "butt", "poop", "sex", "sexy",
  "nude", "rape", "meth", "crack", "coke", "weed", "dope", "smack", "molly", "lsd", "dmt", "oxy", "kkk", "isis",
  "spic", "chink", "gook", "coon", "dyke", "homo", "jap", "gyp", "kill", "gun", "guns", "bomb", "stab", "shoot",
  "die", "dead", "devil", "demon", "god", "jesus", "christ", "allah", "buddha", "messiah", "prophet",
];

const N_STEMS = OFFENSIVE_STEMS.map(normalize);
const N_WORDS = new Set(OFFENSIVE_WORDS.map(normalize));

/** Whole words of a name, also split at CamelCase humps: "KaleHell AI" -> kalehell, kale, hell, ai. */
function nameParts(name: string): string[] {
  const parts = tokens(name);
  for (const w of name.split(/[\s.\-_/,:;!?'"()]+/)) {
    for (const hump of w.split(/(?<=[a-z])(?=[A-Z])/)) parts.push(normalize(hump));
  }
  return parts.filter((p) => p.length > 0);
}

/** Why a generated NAME would embarrass someone (see OFFENSIVE_STEMS), or null if it is fine. */
export function offensiveNameReason(name: string): string | null {
  const n = normalize(name);
  for (const s of N_STEMS) if (n.includes(s)) return `offensive "${s}"`;
  for (const p of nameParts(name)) if (N_WORDS.has(p)) return `offensive "${p}"`;
  if (N_WORDS.has(n)) return `offensive "${n}"`;
  return null;
}
