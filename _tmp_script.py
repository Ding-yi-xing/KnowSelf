import sys, json
d = json.load(open('C:/Users/40179/Documents/AllProjecks/knowSelf/conv.json', encoding='utf-16'))
print('total:', d['total'])
for i in d['items']:
    title = i.get('title', '(no title)')
    mid = i['id'][:8]
    mc = i['message_count']
    print(f'  {mid}... {title} msgs={mc}')
