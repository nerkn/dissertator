1) We have sources and documents, documents means we can edit and We can use in our program
Documents are MD files. Currently everything is saved on a table and we want it to be in folder. 
The problem is we wantuser toedit, and we should be able to detect those edits, and inject our system. 
2) We dont detect references properly, in db references mainly unusable, 
  a) i propose , asking llm to extract those info based on first chunks
  b) we try to extract from pdf and we send unables
3) better referencing :we use ineditor referencing, clicking leads to respected file, for references we can use premade system based on
[SurnameOfAuthorN:year:pageNo]. Since author can publish similar articles we can reference them by number N, we can save "[Tek3:2021:" in db field 
to quick search in text and find respected file, 
4)left sources panel needs redesign(sort=name|filecdate|author|publishyear) and with cards ( title, author, year) long fields truncated, on hover
detailed view, also we need edit details page/dialog for user to edit
5) can llm change filename? move file ? your evaluation. 
6) we want user customizable personality + rules + agents files to be injected in chat, so that user can tweak llms responds
