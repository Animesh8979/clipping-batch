const fs = require('fs');
let code = fs.readFileSync('scheduler.js', 'utf8');

const regex = /const SLOTS = \[[\s\S]*?\];/;

const newSlots = `const SLOTS = [
  { hour: 7, minute: 0, type: 'story', label: 'Slot 1 (7:00AM)   STORY PART 1/3' },
  { hour: 10, minute: 0, type: 'news', label: 'Slot 2 (10:00AM)  NEWS SLOT 1' },
  { hour: 13, minute: 0, type: 'news', label: 'Slot 3 (1:00PM)   NEWS SLOT 2' },
  { hour: 16, minute: 0, type: 'story', label: 'Slot 4 (4:00PM)   STORY PART 2/3' },
  { hour: 19, minute: 0, type: 'news', label: 'Slot 5 (7:00PM)   NEWS SLOT 3' },
  { hour: 22, minute: 0, type: 'story', label: 'Slot 6 (10:00PM)  STORY PART 3/3' },
];`;

if (regex.test(code)) {
  fs.writeFileSync('scheduler.js', code.replace(regex, newSlots), 'utf8');
  console.log('Replaced SLOTS successfully');
} else {
  console.log('Could not find oldSlots');
}
