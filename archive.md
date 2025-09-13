---
layout: page
title: Archive
permalink: /archive/
---

All posts, newest first.

{% assign posts_by_year = site.posts | group_by_exp: "p", "p.date | date: '%Y'" %}
{% for year in posts_by_year %}
## {{ year.name }}

<ul class="archive-list">
{% for post in year.items %}
  <li>
    <code>{{ post.date | date: "%m-%d" }}</code> &nbsp;
    <a href="{{ post.url | relative_url }}">{{ post.title | escape }}</a>
  </li>
{% endfor %}
</ul>
{% endfor %}
