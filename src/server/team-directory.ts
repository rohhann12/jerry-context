import type { DatabaseSync } from 'node:sqlite';

export const TEAM_DIRECTORY_SOURCE = 'https://empty-bite-b73.notion.site/Meet-the-Team-f79d506b64204fb59e7d627cc8896ba8';

export const TEAM_DIRECTORY: [name: string, role: string, interests: string[]][] = [
  ['Shail Daswani', 'Co-founder & CEO', ['Strength Training', 'Blogging', 'Furniture Thrifting', 'Day Drinking']],
  ['Rishabh Agnihotri', 'Co-founder & CPO', ['Stock Markets', 'High-rise Living', 'Movie Marathons']],
  ['Mayank Lalwani', 'Co-founder & COO', ['Poetry', 'Dancing', 'Cooking', 'Scuba Diving', 'Songwriting', 'Swimming']],
  ['Purva Jadhav', 'Product Ops Manager', ['All things DIY', 'Reading', 'Furniture Thrifting']],
  ['Mohosin Choudhury', 'Product Experience Associate', ['Cooking', 'Road Trips', 'Podcasts', 'Fitness']],
  ['Max Binny', 'Customer Experience Executive', ['Road Trips', 'Movie Marathons', 'Music', 'Driving', 'Cooking']],
  ['Dhiram Shah', 'Director - Demand Growth', ['Road Trips', 'Collecting Lego', 'Movie Marathons', 'All things DIY', 'Cars', 'Travel']],
  ['Chetan Sai', 'Demand Ops Associate', ['Football', 'Hiking', 'Backpacking', 'Movies']],
  ['Himanshu Bajaj', 'Operations Associate', ['Football', 'Food', 'Sports', 'Dancing']],
  ['Ayub Ansari', 'Visual Lead', ['Art', 'Fitness', 'Gardening', 'Rare coins', 'Photography', 'Films', 'Music']],
  ['Shanafil Ahamed N', 'Operation Associate', ['Football', 'Reading']],
  ['Shivoham', 'Product Ops Associate', ['Music', 'Road Trips', 'Stock Markets', 'High-rise Living', 'Sports', 'Speed Cruising']],
  ['Visha', 'Product Ops Associate', ['Reading', 'Films', 'Cooking', 'Documentaries', 'Sudoku']],
  ['Anushka Ghorpade', 'Brand & Comms Associate', ['Reading', 'Music', 'Backpacking', 'Surfing', 'Strength Training', 'Running', 'Pole']],
  ['Sherin Lobo', 'People Operations Executive', ['Gaming', 'Gardening', 'Travel', 'Badminton', 'Animals', 'Singing', 'Painting']],
  ['Shubh Goel', 'Growth Manager (Supply)', ['Strength Training', 'Podcasts', 'Pranking', 'Chess', 'Psychology', 'Food']],
  ['Ashish Oberoi', 'Director Supply Growth', ['Swimming', 'Road Trips', 'Cricket', 'Music', 'Trekking', 'Cooking', 'Geography', 'Tennis', 'Stock Markets', 'Cinema']],
  ['Raghav Malhotra', 'Growth Lead - Supply', ['F1', 'Bar hopping', 'Flâneuring', 'Podcasts', 'Psychology', 'Cycling', 'Architecture']],
  ['Maurya Sreelatha Subby', 'Senior Associate - Finance', ['Photography', 'Food', 'Fitness', 'Long Drives', 'Music']],
  ['Shreya Bhagwat', 'Product Ops Associate', ['Basketball', 'Road Trips', 'Dancing', 'Reading', 'Music', 'Binge-watching']],
  ['Joel Mihavel', 'Product Designer', ['Cooking', 'Reading', 'Music', 'Movies', 'Memes', 'Watches', 'Anime']],
  ['Chhavi Daswani', 'Senior Product Operations Associate', ['Blogging', 'Dancing', 'All things DIY', 'Art', 'Movies', 'Furniture Thrifting', 'Styling', 'Swimming']],
  ['Srashti Koshta', 'Customer Experience Associate', ['Dancing', 'Movie Marathons', 'Road Trips', 'Styling', 'Fitness', 'Music']],
  ['Jyotirmya', 'Visual Designer', ['Poetry', 'Reading', 'Art', 'Theatre', 'Gaming', 'Writing', 'Basketball']],
  ['Aman Sonawane', 'Sr. Associate – Founder’s Office', ['Blogs', 'Video Games', 'Motorcycling', 'Books', 'Cricket', 'Strength Training', 'Movies', 'Superheroes', 'Hip-Hop']],
  ['Vidyuth Sridhar', 'AI Engineer', ['Tennis', 'Football', 'Binge-watching', 'Pickleball', 'Sci-fi']],
  ['Nayan SK', 'Demand Operations Associate', ['Cooking', 'Fitness', 'Football', 'Hiking', 'Food', 'Travel', 'Badminton', 'Frisbee', 'Monopoly']],
  ['Tanmay Rakshe', 'Supply Growth Executive', ['High-rise Living', 'Day Drinking', 'Cars', 'Backpacking']],
  ['Ashita Jain', 'Product Designer', ['Fitness', 'Bar hopping', 'Films', 'Photography', 'Art', 'Conspiracy theories', 'Travel']],
  ['Naeem', 'Supply Growth Executive', ['Strength Training', 'Cooking', 'Movie Marathons', 'Fitness', 'Sports']],
  ['Ekta', 'Senior Associate - Brand & Marketing', ['Making videos', 'Reading', 'Vegan cooking', 'Writing essays', 'Lifting weights', 'Claude']],
  ['Tanveer Ansari', 'Customer Experience Associate', ['Travel', 'Documentaries', 'Reading', 'Walking', 'Claude']],
  ['Rashmi Muthuraj', 'Senior Associate - Customer Experience', ['Lifting weights', 'Hosting', 'Beach and mountains', 'Podcasts', 'Bangalore', 'Books', 'Design']],
  ['Rohan Sharma', 'Product Engineer', ['Fitness', 'Football', 'Badminton', 'Guitar', 'Basketball', 'Cinema', 'DHH', 'Bar hopping', 'Reading', 'Music', 'Sports', 'Pranking']],
];

export function seedTeamDirectory(db: DatabaseSync, orgId: number): void {
  const insert = db.prepare(`INSERT INTO team_profiles (org_id,name,role,interests,source_url)
    VALUES (?,?,?,?,?) ON CONFLICT(org_id,name) DO UPDATE SET role=excluded.role,interests=excluded.interests,source_url=excluded.source_url,updated_at=CURRENT_TIMESTAMP`);
  for (const [name, role, interests] of TEAM_DIRECTORY) insert.run(orgId, name, role, JSON.stringify(interests), TEAM_DIRECTORY_SOURCE);
}
