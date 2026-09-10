"""Unicode 15.0 full case folding shared with the TypeScript cache."""

from __future__ import annotations

import base64
import zlib
from functools import lru_cache


PINNED_UNICODE_VERSION = "15.0.0"
# Generated from the Unicode 15 CaseFolding table used by the TypeScript 5.2 cache.
_COMPRESSED_CASE_FOLD_ROWS = (
    "c-mE)UApTiuY~VCmc9rejQw~t=5PK(IQ3RK=j(N`m&-{gl?@U|up>QZIwC)3KB7ElIU=4jj;POBk2s(6Jfb~kJK}oI>xla~?<3yl"
    "e2?hQ*^d~{IgXgmIgeP+xsKS+xsUpJ+UKb0Y3Zo>Y5Az-Y2~Q#v^Z*gT0QFdwDYL#Y3-=j)2^f5PrHx$KJ7hveM%q4_&n=#jP$H@"
    "jQp&8jPk5<jCfWYqdu!1<9yb6jP|T{jO$s~G45yG$9SLh9-}|2A7eaAZ1Y+380%T<82efKn4f2Vj+vgFj+vjGk6E5wjv3F6W7cQa"
    "W1i1Gk9j@&I_CZC`<U;u-(&V?_hXJ{k7Lef&ttA<uVZdK>OXqg^!YsLlXT6xav!=@T~A$`u9vR2uCK0L*P-jwb?Lf~l+-?{eNy|R"
    "_DSuN+9$P7YM<0TseMxWr1nYeliDY>PimjlKC69J`>gg^?X%ivwa;pw)jq3zR{N~>S?#mhXSL62Uq0&ae+p8ID2gbGD2gbGC<>q7"
    "y1u%0U5Bny*QM)zQhbgSN!P4v(KU3fx}Lf=T`yhlC-?D>Mo!YeN+A^*R4JrF11g17XfUO!r_ex3RT4CaQk4V^pj0J6gC|uzg$7Ql"
    "YG2j9s(n@as`jVaYn-Q3?KQ^JsrDM*=~R1-?R2WW#&tT?USm3)YOnE}PPNxqPEGAKj#E>6dbO#&#&2qBud$n&Mg~9Ao6x{bO>d&<"
    "O*FlUrpIawha+9-$*8}?a&Z;QC6?>d=Xx=hUdW{va_NOsy`byWRqU7OF40|5Go|X<`dn)7kFHXC>jmF>!FPG`sTY2SuHwJN%TwJ="
    "SMlC@%A5P4d&#}$lN;^C$J4xe%2!YMO5dyYuk^iqE}l!guk^j*d8H5iuinxtJ@3*zpR2>We%JM!mtI59x=LSH$9FxS96EJ9SC=02"
    "cIoNT)5X)pBaco)-^-`JSJ@l-ULO6us&|IogZ%k>)$1L4z4GHUWmi6&rg-JQY092_H%;+O@l5HH=cXxL^4c`je)2x`9+sY4!6hv{"
    "w*pIA(xIS|mU>qKB`w)kFiA`H6-d&OUIme~)LsE3ZTZM69}(r21jUZD^S@V7DSo6as++5%bef1#Q6z0qDuSdfN=1*fMX8aL6*jWM"
    "MpoF!3L9BrBP(oVg^es<%nBP>VIwPSWQC2au#puuvcg7I*vJYSSz#k9Y-ELvtgw+4HnPG-R@lf28(Co^D{N$ijjXVd6*jWMMpoF!"
    "gpGUYs`d&SSz#k9Y-ELvtgw+4HnPG-R@lf28(Co^D{N$ijjXVd6*h8_eZ`Edn30QqH{@|yK_V+iWP-%~>bm&iJhGxhR+Pv@2@STa"
    "c_?49plFdb__OAs9I~u=C<mX5QK2F$RAhyUtWc2^DoQYG+((hi7P)MZ%N99bk*gNDYLPD%^-Ph|m3QcR={j}2bzQo?x{Bu-PZ@l_"
    "bme=s(_kxdI`ONwFZ~n0oUe4QveUD!MOX3535y1OxzST~l|2pqB4;dJI^>L{U%K93y|?W4SJ$p<*L8UID{|5z=P0*ybnHuqMo^Kn"
    "mhsV5_J{1hvO8o~PFsfTzOp-HSI%4HOhwLHhU~twJ7iZ*T;x>cmE9q`uj~%l?eNzBJ)fpr^UBG}RQvh)KIcqd{j+}g=lRv6NwQ4w"
    "YJx0Ne3~4Kf>x2U6**gxvlTg8k+T&!TamLBIa`sl6**gxvlTg8k+T&!TamLBIa`sl6**hkpYMCx|33GQua5oidzOcl&Apyab9s@6"
    "6?s_MdXJ5(codt<*7GziS>$O^Ke{GewG@)aMb%>HQ*_mGNS+r8&he?bYDpvy3<c--G+nhUk|##h!sv7Bs-=-UGO89wpRTKxNAk?5"
    "S|EL<uGm|;YLWEWy6z+7sZnG<$-X=$<grm?Kgqs4C*-+NWIxHiX5EknN0I#``<i`2o*YH?lk6ASmq&+Y<4Ce!WM7^ga=1vcUu0h%"
    "9-5sa$$pW2d3tD;jx77ZQc(8ghmmDJWM7^inzbX#e#pKeKxp=kEc^1uP$US=;*n)vei@1g5wf3UU;Y`23=y)QWnX?8iVzX9pJiYE"
    "8k(AeC8(z6VEL)3IlT0g9hRM%nu8^$rsiO|si`?wYHDf@O=2NG5BYh>&qID5nwmqCS;*f*{vMi|LrcnNYOnr}ruOuEQ~Rd&m)c)y"
    "FTW2>Rw2KSOW(`y<I?x?_qg@F{5x*(%dbO`Jmk-Di(h^mnp8vn8@JlaZ{t>b`D@&2FFy@Us-a0WG^vLCGc>7&{4!p(mp{hKl3MLw"
    "wb!H?ibtVIH57+J{uqicp~*B9SE8%E#(8wLR~!jVqM`T^UF{V&LX&AIUPM=W#fi}JIR;nt?@+&L@f?Z|p-DF6x1mWk6c0iR=1?36"
    "O|GH17n)o{@h;@=F=by%<CwCqWpPZ|m%oSNLCD`j{vPu8kiUogJ>>5pe-HV4$lpW$9`g5)zlZ!i<nJMW5BYn@-$VW$^7oLxhx|Pj"
    "sf60g-$VW$TA7Dt)KJ_G`Fm(a4b7;r)m}4cXeJH$dC1R0Gihih4f%O&(vZ(n700Ulx@sn^^5?3Vw91dGX3{GEt(r-z{I+T)t@78Z"
    "nY7AJt7g(F|E!uxtNgNRCav<vs+qLP536R<D*vmRNvr&>Y9_7nx2l=6%Fn81(klO|nG{IvHIr8PQ`Jmb<wsRBX_fy}&7@U+Q#F%T"
    "`AgMITIDBIGifd9sq&AinY5lHQAJnrXcb<SsMS(+6`xk)Rr6>qO;_<2@oLdmwK}izpQ;(SDru{lfUEqd7THnaRy7e<`BT+IT(tzR"
    "TD4cww~%fUIL*tI6izu}C5hAgT%E?rK8c*>+e#{@`MHwJX;oiI=QK}O5<0E!D=D4k>#DVJRn}PLhgI`-RUEF$9IO1XYW}WTD_3QY"
    "Reo8u<gZ!>RArD={#mv3ub1pAi>z9FR;2*-B9WAREuyPZfqKdQ#q-yH_^pyEEkow#14<wgF*%};zbzn=GC8GCfGUUtjaBdboS+6G"
    "S(CF0U7#D}#O(#WpbjF5lM@RK&;*gtu}Yqw1==930zVyn34N@YCyCyNRr5^f>*yot`*idr^mX)+0De0968czAPm;k;M_)o;M<0pd"
    "r=u^SucMD7@zc?l(AUvN!uaXvOX%z9BYFG`^kwu7^pQw@2KqAk2Kq=UKLdRkeFJ?Yn4f_vQq0f521#XM*{c~GMA9g~PE62=nOc8H"
    "AXzmRmcyFaK_ru`pa+3k6Qe-#j3|&jl?fEjT>|0BOQ8P1>FG$Id43VNp7$il95=Z+iNhd+`b-#Z@^q4jp@p0fEpBpl5{jY4oDgbm"
    "@^_Mpp#_~#1Ch&<Xbdgtgh*L#@_Levp@p50?K;ONfzjelh}7pM-=92;7I;FNbO(J4eJ}b*Q3ko$XQA&!AL+^<Px~zNz33x#887-4"
    "`pDWoq%q?~-$LJuzU7n(eG7dr`bcjEdEIBB??oS}&Un$c&_|Z{A?+C*ee~w&=%Y7BM<2a8$of9?=IH37HwPKu$GzFnx6#+px6wyF"
    "_}S>|=p#QG9eo>p9WCTYqq{bOmX4O~6pkDY|6WvD7GAxmwJdyjQEgdx@S@(b@Y_YjW#O%hn#;mR7gd*qXRhR&5I!m|3ol&MUKYN$"
    "sJ<*bZc%?(_}QWYv+%A(4QAm}iz>{*lNJfp%1$!j!)q3`n1!z_sxb>+S=3_|1(`)fW>Jz^)MOU^v#81}$}+3KSKuqoTH&KGv#880"
    "N;8Yv%qs8|_zHXlz5-u?ufSK}3;6J%74U`AVE6*QfG^++_yRs^H48slRBIOHnnk^4QLtH5Y!)S(Ma^bW_E^<<HGI@<7Nw0v<z`XL"
    "Sk!J7<%~u3W>LOb)Nd9AoJ9p^QNmf&a2B4tsN$^Ci8_1~au$`GMbTqX%UKk27S)_ZIcHJNS(H8&6`e&%XHnBxlxG%IokbyJHD~_t"
    "HTW8Q4Za3ngRjBY;A`+*@Lljx-C2}J7WJJ)foEOtT`ncScfohTM|osj@Lljx;aL}a#HMw_M?_jTe8ize6=5m*oXXGK|B62?$k)Kv"
    ")0*%Lrj+`_?{lVqvhqja{(F;(IsaBE7olcR`&k5-_4+f+QU6&4ll3B>5VBs^LXiI=pK!6L11*BYdXZ0PSRFnB!s_r523Cg;=U*K@"
    "Tz*jlTHVDJ_$UW0>Ol)fUzAJMfN#Jz;2ZE!E?NV=0pEa+QqiJTv?vy>;c5+h1HJ*@fN#P_z+V$S!u*=>5!}~=kC475d<60};Uj#n"
    ">GBVJ6p)rHNG>6{hU6lWt4J;*xsK#Qk}F9rCApU5Vv?&#E+>8KN$?R`*M^UPx~L>A!sw!wv<RMyYSJQPE+*7Ppj=F&i&D~J@>~SU"
    "wOyccg^GF;3!$w%ReutQ+7k<*tz1=qC|3~*Hw&Syd{uuaSrHUB3!$x?Reu^~F8Elu>;xZyauWbI3zwbXBV=wu;b!5o6MO{EO^Dkp"
    "Dt4wVL2(o8Hj9d#X`5X_qb-YyooSoh7A+Yq87+j&O^DkCJ}S{0r`QC$&1zv&mEMHMP1xHk95%(LO`zNaz+K>@TD=LGn-I4tT<?I7"
    "ptuQkn+3%V_`;<<_$X-afR8}A>%Y|#KYY!<8@VBTHU9GfwDtVo2WGEWto{l+)ikhIv!ju)xe0TdTJJt-fje&k-acVDX-kOQguZ>E"
    "@r31cDUxSCdFB&7!saG?X?*-cDN1+AW8`<2Jx+di#bf1n7alLayXrCXyE{E@es|4d=XZDgv3LKm_x`ch|JWOU?9D&+)*pNOzxD{H"
    "8gsw9<Z<`A%N~2byW;Wpy9<xO-(B@M{N0@%i@&?(@%X#D{@A<!*n9uj>woNxKlbJyd+U$A{a<^;Z;glFUGkXt-DQu9-(B(8_}zua"
    "$M3FsjQs9SkCWeB^H}-aU4QJ|f9$<~?DaqP#vgn0kG=KB-u|yWW|7@~_Bu7zpE*q{<sHA9^ZSjRskh(F?^{%}L$O(4Zsw=Wyd!21"
    "N}E3$|K(rL7Yu9oX&-3#$s1@`znk;>jWvw+yZL>KhUTx(!0fw+HQ=Sg8t~FF{=+}>e~Qj%o#jszS|6O>4{UU{|9$)Y0Hf0lF*@DC"
    "MhOGcMhOEe|EKuN&sX_V4b}&Qu=H<$TmObH+gR;?KmC4y(Pb8lE;qN)7i6PseK7xR=E?0{llJS&jqUq)gWca7-skrlo1x(Qz4?9X"
    "H++HohW(lCvO%+Lm#vmP{+~ayA4)kqvk`i-A)<L`v0=gvMvBGO341CUDMAUv_R7h(>P?{nVyoq3uSLBnR6*W$@xIFmY9O{?PWE7="
    "Q|Ja^{bWBz??<SEP;#<2Bke*H#5T>zK25W#4PwjZLct}w)CO}*Hc==IP`=C535D2Tp)^1#FH<uVa*GbCAn&KJAwy|^5?`j4D0G1~"
    "i0v0j1EIt=Q(4TE{)94!%^FGrlmUeTv_KWKLFilPqewt`PzZeseFJ?9eFJ?9eFJ^;M-22W^ifuzgeZi*g}#A4t*`Q62W@CoAe2A}"
    "ltCF(Km`<_098;0ouCucKn-+(F3=6K4R*E43+kW_8lVB1pb27=t1Qq4=^YGq=tiI~p)b(KZrxxLY$Wsr`q;S}fxd*kKp(q!BhZ)7"
    "$F|sDM{flB68hL88|?0lKwm;1+hv2Dz7gn4=ws__u<JJ%<0GLj(3jCy(U;Lz(Z_D!sOZb+tLS5Aa8&eV^i}k+OE@a}GWsg|*fAUx"
    "eHncfee52NioT4#iavG{M@3&oUqv6gild@0qpzY5ZyYD8@IhR5ob3DJ9s?Kr0_>ky#mB~pEj(+SSiqnBV7OB=U~8R+ZtSh|q>X3B"
    "uSetg@Zq7fFS`>P!;PO`sJURc`2EH2FW$_>`(T5AT)c&gx4^dMU~_+5$i8^u3$+)|c|pw9{<z`0;k)5uTYuc}v9UjH_-^=a_-^=a"
    "_}JbbH+(mIH+&RA#|t0j&+)=X(Q~};QR*Bod=xmx3m;|8@xn(jbG-0T!W=Jr6fQ@Hk8<Vc@KK~39X{gE=<pGB1_72rj{d+$gc%(^"
    ";>zgo5lzN`j~Frrd_;~h;3Hm)0UuFf5T^&RVGQ_)2xGuU92f(>2_JE9O!$a)W5P#_8xuYv+nDeX&&Gt0C^ja1#I7;nBVvsOA8~3d"
    "_=rwpF^(4FXfaY3<8$+^vbFb&4`s##${>Fhpb9!c4dim<4SK(YN&Ok130j~nRN<@eRro4=6}}2zg|EU_;j8df_$quAz6xK3ufli2"
    "cfxnVcfxnVcfxnVcfxnVcfxnVcfxnVcfxnUa=~)Ja=~)Ja=~)Ja>3%F>jldN%LU5?%Vic+U8uU@yWzXxyWzXxyWzXxyWzXxyWzXx"
    ")3|?|qLcm<P=G4v1U1kFx<N0<Ee2?U7Dx(Ofu+DwU@5Q^SPCo!mI6zGrNB~PDX<h+3M}+~qxT!V-{}2D?>BnC(ff_wZ}fhn_Zz+6"
    "=>10TH+sL(`;Fdj^nRoF8@=D?{YLLMdcV>8joxqcexvsrz2E5lM(;OzztQ`R-f#4NqxT!V-{}2D?>BnC(ff_wZ}fhn_Zz+6=>10T"
    "H+sLF@SX6rTS)5`{pp|qnuKH8Hh$Om9pj}jUK-=2F<u(ur7>O_<E1fP+6Bu6i*medQ4Ed7&}a;e#?WXCh{k|u42Z^nXbgzv0dXVr"
    "M(B-z8v!pYFDx%CFDx$tUTnPZz3{#8z3>qTl`RX%-z$;`h<<l$?wtNaf#T%piHr9Fa0Ut@;-fVvX?eRlu4AubuVb(KXV~l5>*(+3"
    "@96Jti~f%Of&PK<f&KyCfbR|vhh;M0<j503w8GM#3q&6cR8B}HBohG>0TTfe0lNxqJ#nW<THX&Rff9&QfNusBPyulw@C{G}RS>5G"
    "U$Zn&1F`+{ULc<tyg_XLyf29DAI&&IZ2!Ci#P*No9-#$VpbgT?=u|CAM;{dnj^PNQucMDj1xIm&(AUvNg@R)uLg?%0qcXvf93k{|"
    "^ih!@F%UvuM<104j^+rVucMC&1jloP(AUvN<$)tQZ>Q?Op%@|b(QTb-LmB9!(!kLgA@mLOQDNZNju83=`lu{$bVmq%^kt`_K)xb`"
    "K6<s^K7WZmst6oj5<=fVAJqd6FbSb=ppU9SndqZpP#6)NYC)Okqf$^N`lu3=i9RX>WulMjK$+;HGQiOwA@oi3Q4!!6kP!MN`ltkO"
    "BuEH-6Ma+wI36T~zKK3Ee~t>hohou!=wpM4V?#pdTj*nhi6cZp=v(MxgNfrrLg-uQV}psKMMCIX=p+B<n2`|r7W&BlIdUX~zJ<Q-"
    "v#jW&7F`zl*mUA3((cMJ&hsAy2f<``1GC`(mhTV#{UUyM{;s<E9>DYeVPbnd{$VR!H}Snu{L@YS_oj2hZu|QEto{4VJd{GGXH&Bj"
    "%AgD?paKd|fGVhhPS6Qzpa$YVtFnnrjaKLey`UG=K^-(e12jQaus{p6L3&fWe1x>H7D8V|UqN3*UqN3*UqN3*UqN3*UqN3*UqN3*"
    "UqN3*UqN3*UqN4GqdR=+I`U<ljBn#?{QXTa?#5v}jH~f9K8=@gGv3DRRB~(!d>bd@*Ekz@W1so<scvste>eyRuExvwG~UK+m~$u$"
    "Z2igli}fe#FV>%|zgT~={$l;f`iu1^>o3-ytiM=)vi`9CWc^|N$@;_kll6!7C+iREPu3sSpR7NuKUsfRf42Ux{%rkW{n`4%`m^<i"
    "^=Io3>(AC7)}O6EtUp_SSig6ksYrm$Kh5vmXQ~ol^H1}82b#(R*!<J{-i4+*0XF~q^85WPzaQ^KQ=<U;{Vczq?)S6&e!Ab!^84{V"
    "HMI(`-_P><@m@9c3jH0{zpQ^)|FZsJ{mc4?^)Krm*1xQOSpTyAVg1YchxIS(AJ)IEe^~#v{$c&w`iJ#z>mSy?t$$emw*F!L+xmy~"
    "Z|k4dzpZ~-|F-^V{oDGd^|K@OsVpQu^=`(=_%hDMw{bCkjs3qQ?r+;_Jd97{Y21vL@nyV?dEWYdj9=qqJdBI+G!ElsT#dIe&s#5R"
    "ey#bk=GU4pYksZyvgX&CFKd3S`LgEMnlEd9t@*O%*P1VDey#bk=5EcGHFs;ithrnBWzF51FKh1Bd|7k1W}j%O-I{%-rFLufsg~NU"
    "*{4}*w@#mDsU4le&#Oe-I2rr6kDpg*xp6V}ksm*=l62#0>|;NE-og3(&+zk-xq~m`%lJ0FjbG!}xEuTb!T8z7_-dQR(|8##<8ADt"
    "N`Ce+t>4d1{tvePY5hLaLp1<w{nPsW9;gj~t$$j-&-PF$09(If&i8!JaLoCh@EMLd-!neLG3R^AXE^43&-o0;obO4W;h6J1>oXj4"
    "zNdYLW6t-y&v4B7p7<G#Io~rs!!hT3>Ss9Se9!$1$DHrUpW&GEJ^M2pbH1m4hGWk6{LgUA`JMn8jyc~mK*KTTdkSbc=6ufq4ac1C"
    "Nuc4F^F0eR9CN;>freww_dL*W%=w-O8pND*@r>zWj0q>>WSot^zbVGWIE=%%8du}f_%v?D{=ZN>qwr;X8{fvS@oU_TyYVm{#?yEj"
    "FXLsrjrqS=SGWFY{oVSf^>^!^*59pvT7S3xY5m>$r}cO1pVr^4e_DUH{%QT)`lt1G>z~%&t$$j7xBhAU-TJ5Xck7?l->si9cKVdh"
    "x!5-rPR7YN8)xHUT#UmwjH_`qK8;V~X55S~<IDIqzKvhw*SH&Z<6%6Er?LOn73YYAm+>~X{%ZZr`m6Of>#x?|tiM`+v;J!R&HAhL"
    "H|wv~->kn{f3yB-{muHT^*8IU*59nZT7R?tYW>antMxbQuh!qJzgmC$9_sO_9?m%kCu1M%@tL)ovkt<=*vEW)g6-zKgK#x&#;385"
    "{ID(+zK#7qm9mfgur3wu#;@@(?#9!282eZd>r&yb&gC;lALDK814BL)cNgnV*6)L7clw@Dvi@ZKK8AMt#N1u1KUu#IrQJS1cNgnV"
    "*6$-~w@=gE#rl)=`@q`mvvqf|{$%|=zIOYh-Ce9dS-%gn-9C4BhxI4xkMB_`>ksSC*01&L{{aF=^Ed"
)


@lru_cache(maxsize=1)
def _case_fold_table() -> dict[int, str]:
    rows = zlib.decompress(base64.b85decode(_COMPRESSED_CASE_FOLD_ROWS)).decode("ascii")
    table: dict[int, str] = {}
    for row in rows.splitlines():
        source, targets = row.split(";", 1)
        table[int(source, 16)] = "".join(chr(int(target, 16)) for target in targets.split(","))
    return table


def pinned_unicode_15_casefold(value: str) -> str:
    table = _case_fold_table()
    return "".join(table.get(ord(character), character) for character in value)


__all__ = ["PINNED_UNICODE_VERSION", "pinned_unicode_15_casefold"]
